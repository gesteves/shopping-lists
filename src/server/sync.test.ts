import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { HlcClock, serialize } from "@/shared/hlc";
import { MAX_PUSH_BYTES, MAX_PUSH_OPS, type PullResponse } from "@/shared/sync";
import { SAM, createTestDb } from "@/test/db";
import { setListSummary } from "./ops";
import { purgeTombstones } from "./purge";
import { handlePull, handlePush } from "./sync";

const CLIENT = "3c3c3c3c-0000-4000-8000-000000000000";
const LIST = "11111111-1111-4111-8111-111111111111";
const NOW = 1_764_000_000_000;
/** A purge time: more than 30 days after the server wrote the deletes. */
const LATER = NOW + 31 * 24 * 60 * 60 * 1000;

let db: Db;
let clock: HlcClock;
let counter = 0;

beforeEach(() => {
  db = createTestDb();
  clock = new HlcClock("server", undefined, () => NOW);
});

afterEach(() => db.$client.close());

/** A raw op, as the client sends it. */
function op(type: string, args: Record<string, unknown>, wall = NOW - 1000) {
  counter++;
  return {
    opId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    clientId: CLIENT,
    hlc: serialize({ wall, counter: counter % 100, node: CLIENT }),
    type,
    args,
  };
}

function itemId(n: number) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

function pushRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function push(ops: unknown[]) {
  const res = await handlePush(
    pushRequest({ clientId: CLIENT, ops }),
    { id: SAM.id },
    { db, clock, now: () => NOW },
  );
  return { status: res.status, body: await res.json() };
}

async function pull(query = ""): Promise<PullResponse & { status: number }> {
  const res = handlePull(
    new Request(`http://localhost/api/sync/pull${query}`),
    SAM.id,
    { db, now: () => NOW },
  );
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { status: res.status, ...(await res.json()) };
}

describe("list summaries (#143)", () => {
  it("sends the summary key, and if the server makes summaries", async () => {
    await push([
      op("createList", { listId: LIST, name: "Pierre’s General Store" }),
    ]);
    setListSummary(LIST, "Milk and eggs", "key-1", { db });
    const res = handlePull(
      new Request("http://localhost/api/sync/pull?since=0"),
      SAM.id,
      { db, now: () => NOW, summaries: true },
    );
    const page = (await res.json()) as PullResponse;
    expect(page.summaries).toBe(true);
    expect(page.lists[0]).toMatchObject({
      summary: "Milk and eggs",
      summaryKey: "key-1",
    });
  });
});

describe("push then pull", () => {
  it("returns the changes, the users, and the new cursor", async () => {
    const create = op("createList", {
      listId: LIST,
      name: "Pierre’s General Store",
    });
    const add = op("addItem", {
      itemId: itemId(1),
      listId: LIST,
      name: "Milk",
    });
    const pushed = await push([create, add]);
    expect(pushed).toEqual({
      status: 200,
      body: {
        results: [
          { opId: create.opId, status: "applied", changed: true },
          { opId: add.opId, status: "applied", changed: true },
        ],
        seq: 2,
        now: NOW,
      },
    });

    const page = await pull("?since=0");
    expect(page).toMatchObject({
      status: 200,
      reset: false,
      cursor: 2,
      hasMore: false,
      hlc: add.hlc,
      now: NOW,
      // No ANTHROPIC_API_KEY in the tests: no summary worker (#143).
      summaries: false,
    });
    expect(page.users).toHaveLength(2);
    expect(page.users).toContainEqual({ id: SAM.id, name: "Sam", image: null });
    expect(page.lists).toEqual([
      {
        id: LIST,
        name: "Pierre’s General Store",
        createdBy: SAM.id,
        createdAt: NOW - 1000,
        updatedBy: SAM.id,
        updatedAt: NOW - 1000,
        updatedVia: "app",
        deletedAt: null,
        summary: null,
        summaryKey: null,
        private: false,
        seq: 1,
      },
    ]);
    expect(page.items).toEqual([
      expect.objectContaining({
        id: itemId(1),
        listId: LIST,
        name: "Milk",
        quantity: 1,
        notes: "",
        checked: false,
        checkedAt: null,
        seq: 2,
      }),
    ]);
    // No emails and no clocks go to the client.
    expect(JSON.stringify(page)).not.toMatch(/@example\.com|clocks/);
  });

  it("returns only the changes after the cursor, tombstones included", async () => {
    await push([
      op("createList", { listId: LIST, name: "Oasis" }),
      op("addItem", { itemId: itemId(1), listId: LIST, name: "Milk" }),
      op("addItem", { itemId: itemId(2), listId: LIST, name: "Eggs" }),
    ]);
    const first = await pull();
    expect(first.cursor).toBe(3);

    await push([op("deleteItem", { itemId: itemId(1) }, NOW - 500)]);
    const second = await pull(`?since=${first.cursor}`);
    expect(second.lists).toEqual([]);
    expect(second.items).toEqual([
      expect.objectContaining({
        id: itemId(1),
        deletedAt: NOW - 500,
        seq: 4,
      }),
    ]);
    expect(second.cursor).toBe(4);

    const empty = await pull(`?since=${second.cursor}`);
    expect(empty).toMatchObject({
      lists: [],
      items: [],
      hlc: null,
      cursor: 4,
      hasMore: false,
    });
  });

  it("pages through the changes in seq order", async () => {
    await push([
      op("createList", { listId: LIST, name: "JojaMart" }),
      ...[1, 2, 3, 4, 5, 6].map((n) =>
        op("addItem", { itemId: itemId(n), listId: LIST, name: `Item ${n}` }),
      ),
    ]);
    // A list change after the items: the pages must mix lists and items.
    await push([op("renameList", { listId: LIST, name: "Sam's Club" })]);

    const seqs: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await pull(`?since=${cursor}&limit=3`);
      pages++;
      expect(page.lists.length + page.items.length).toBeLessThanOrEqual(3);
      seqs.push(...[...page.lists, ...page.items].map((r) => r.seq));
      expect(page.cursor).toBeGreaterThan(cursor);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    // The list has its last seq only: 8. The items have 2 to 7.
    expect(seqs.sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(pages).toBe(3);
    expect(cursor).toBe(8);
  });
});

describe("push replay", () => {
  it("is safe: the second push applies nothing", async () => {
    const ops = [
      op("createList", { listId: LIST, name: "Oasis" }),
      op("addItem", { itemId: itemId(1), listId: LIST, name: "Milk" }),
      op("check", { itemId: itemId(1) }),
    ];
    const first = await push(ops);
    const before = await pull();
    const again = await push(ops);

    expect(again.status).toBe(200);
    expect(again.body.seq).toBeNull();
    expect(again.body.results.map((r: { status: string }) => r.status)).toEqual(
      ["duplicate", "duplicate", "duplicate"],
    );
    expect(again.body.results[2].original).toEqual(first.body.results[2]);

    const after = await pull();
    expect(after).toEqual(before);
    expect((await pull(`?since=${before.cursor}`)).items).toEqual([]);
  });
});

describe("bad input", () => {
  async function status(request: Request) {
    const res = await handlePush(request, { id: SAM.id }, { db, clock });
    return { status: res.status, body: await res.json() };
  }

  it("gets 400 for a bad push body, and nothing is applied", async () => {
    const good = op("createList", { listId: LIST, name: "Oasis" });
    const other = { ...good, clientId: "someone-else" };
    for (const body of [
      "{not json",
      {},
      { clientId: CLIENT, ops: [] },
      { clientId: CLIENT, ops: [{ ...good, type: "explode" }] },
      { clientId: CLIENT, ops: [good, other] },
      { clientId: "someone-else", ops: [good] },
      { clientId: CLIENT, ops: [good], extra: 1 },
      {
        clientId: CLIENT,
        ops: Array.from({ length: MAX_PUSH_OPS + 1 }, () => good),
      },
    ]) {
      const result = await status(pushRequest(body));
      expect(result.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await pull()).lists).toEqual([]);
  });

  it("names the bad fields", async () => {
    const result = await status(
      pushRequest({ clientId: CLIENT, ops: [op("check", { itemId: "x" })] }),
    );
    expect(result.body).toEqual({
      error: "invalid_request",
      issues: [expect.objectContaining({ path: "ops.0.args.itemId" })],
    });
  });

  it("gets 415 without a JSON content type", async () => {
    const result = await status(
      pushRequest({}, { "content-type": "text/plain" }),
    );
    expect(result.status).toBe(415);
  });

  it("gets 413 for a body that is too large", async () => {
    const big = "x".repeat(MAX_PUSH_BYTES + 1);
    expect((await status(pushRequest(big))).status).toBe(413);
    expect(
      (
        await status(
          pushRequest("{}", { "content-length": String(MAX_PUSH_BYTES + 1) }),
        )
      ).status,
    ).toBe(413);
  });

  it("gets 400 for a bad pull query", async () => {
    for (const query of [
      "?since=-1",
      "?since=abc",
      "?limit=0",
      "?limit=5000",
    ]) {
      expect((await pull(query)).status, query).toBe(400);
    }
  });
});

describe("reset", () => {
  it("starts again from 0 when the cursor is before a purge", async () => {
    const old = NOW - 40 * 24 * 60 * 60 * 1000;
    await push([
      op("createList", { listId: LIST, name: "Oasis" }, old),
      op("addItem", { itemId: itemId(1), listId: LIST, name: "Milk" }, old),
      op("addItem", { itemId: itemId(2), listId: LIST, name: "Eggs" }, old),
      op("deleteItem", { itemId: itemId(1) }, old + 1),
    ]);
    const { purgedSeq } = purgeTombstones(30, { db, now: () => LATER });
    expect(purgedSeq).toBe(4);

    // This client saw seq 2, so it did not get the delete of item 1.
    const page = await pull("?since=2");
    expect(page.reset).toBe(true);
    expect(page.lists.map((l) => l.id)).toEqual([LIST]);
    expect(page.items.map((i) => i.id)).toEqual([itemId(2)]);
    expect(page.cursor).toBe(4);

    // A client that saw the delete does not need a reset.
    expect((await pull("?since=4")).reset).toBe(false);
    expect((await pull("?since=0")).reset).toBe(false);
  });

  it("completes a reset that needs more than one page", async () => {
    const old = NOW - 40 * 24 * 60 * 60 * 1000;
    const adds = Array.from({ length: 6 }, (_, n) =>
      op(
        "addItem",
        { itemId: itemId(n + 1), listId: LIST, name: `I${n}` },
        old,
      ),
    );
    await push([
      op("createList", { listId: LIST, name: "Oasis" }, old),
      ...adds,
      op("deleteItem", { itemId: itemId(6) }, old + 1),
      op("deleteItem", { itemId: itemId(1) }, old + 2),
    ]);
    const { purgedSeq } = purgeTombstones(30, { db, now: () => LATER });
    expect(purgedSeq).toBe(9);

    // The client saw seq 3. It pulls two rows for each page.
    const first = await pull("?since=3&limit=2&seen=0");
    expect(first).toMatchObject({ reset: true, purgedSeq: 9, hasMore: true });

    // Each next page sends the purgedSeq of the first page as `seen`.
    const ids = [...first.lists, ...first.items].map((r) => r.id);
    let cursor = first.cursor;
    for (let n = 0; n < 10; n++) {
      const page = await pull(`?since=${cursor}&limit=2&seen=9`);
      expect(page.reset).toBe(false);
      ids.push(...[...page.lists, ...page.items].map((r) => r.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(ids).toEqual([LIST, itemId(2), itemId(3), itemId(4), itemId(5)]);
    expect(cursor).toBe(9);

    // Without `seen`, the second page resets again, as before.
    expect((await pull(`?since=${first.cursor}&limit=2`)).reset).toBe(true);
    // A client with an old cursor still gets a reset, with an old `seen`.
    expect((await pull("?since=3&seen=4")).reset).toBe(true);
  });

  it("starts again from 0 when the cursor is after the last seq", async () => {
    await push([op("createList", { listId: LIST, name: "Oasis" })]);
    const page = await pull("?since=99");
    expect(page).toMatchObject({ reset: true, cursor: 1 });
    expect(page.lists).toHaveLength(1);
  });
});
