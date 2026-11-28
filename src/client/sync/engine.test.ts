// The client and the server together: the engine's fetch goes to the real
// push and pull handlers, on a temporary SQLite database.
import "fake-indexeddb/auto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { items as serverItems, lists as serverLists } from "@/db/schema";
import { applyOps } from "@/server/ops";
import { handlePull, handlePush } from "@/server/sync";
import { HlcClock, MAX_DRIFT_MS, parse, serialize } from "@/shared/hlc";
import { opSchema, type Op } from "@/shared/ops";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { ClientDb, getMeta, setMeta } from "../db";
import type { ListRecord, PullResponse } from "@/shared/sync";
import { readList } from "../queries";
import {
  SyncEngine,
  type MergedDetail,
  type RejectedDetail,
  type Timers,
} from "./engine";
import {
  loadClock,
  mutateLocal,
  rebuildView,
  resetForUser,
  savePullPage,
  type OpRequest,
} from "./local";

const LIST = "11111111-1111-4111-8111-111111111111";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let serverDb: Db;
let serverClock: HlcClock;
let db: ClientDb;
let dbCount = 0;

/** The fake network. */
const net = {
  online: true,
  authorized: true,
  pushes: 0,
  pulls: 0,
  /** The pull gives 500. */
  failPull: false,
  /** This pull (1 is the first) gives 500. */
  failPullAt: null as number | null,
  /** Each op that went in a push. */
  pushed: [] as Op[],
  /** A push with more ops gets 413. */
  maxOps: Infinity,
  /** A push with this opId gets 400, as an op that the server refuses. */
  poison: null as string | null,
};

/** The real time. Some tests move Date.now of the device. */
const realNow = Date.now.bind(Date);

const fakeFetch: typeof fetch = async (input, init) => {
  if (!net.online) throw new TypeError("Failed to fetch");
  if (!net.authorized) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(String(input), "http://localhost");
  const request = new Request(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  if (url.pathname === "/api/sync/push") {
    net.pushes++;
    const { ops } = JSON.parse(String(init?.body)) as { ops: Op[] };
    if (ops.length > net.maxOps) {
      return Response.json({ error: "too_large" }, { status: 413 });
    }
    if (ops.some((op) => op.opId === net.poison)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    net.pushed.push(...ops);
    return handlePush(
      request,
      { id: SAM.id },
      { db: serverDb, clock: serverClock, now: realNow },
    );
  }
  if (url.pathname === "/api/sync/pull") {
    net.pulls++;
    if (net.failPull || net.pulls === net.failPullAt) {
      return new Response(null, { status: 500 });
    }
    return handlePull(request, SAM.id, { db: serverDb, now: realNow });
  }
  return new Response(null, { status: 404 });
};

/** Timers that run only when the test says so. */
function manualTimers() {
  const pending = new Set<{ fn: () => void; ms: number }>();
  const timers: Timers & { pending: typeof pending; runAll(): void } = {
    pending,
    set(fn, ms) {
      const handle = { fn, ms };
      pending.add(handle);
      return handle;
    },
    clear(handle) {
      pending.delete(handle as { fn: () => void; ms: number });
    },
    runAll() {
      const due = [...pending];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
  return timers;
}

function makeEngine(timers = manualTimers()) {
  const engine = new SyncEngine({ db, fetch: fakeFetch, timers });
  const rejected: RejectedDetail[] = [];
  const merged: MergedDetail[] = [];
  engine.events.addEventListener("rejected", (e) =>
    rejected.push((e as CustomEvent<RejectedDetail>).detail),
  );
  engine.events.addEventListener("merged", (e) =>
    merged.push((e as CustomEvent<MergedDetail>).detail),
  );
  return { engine, timers, rejected, merged };
}

/** The item on the server. */
function serverItem(id: string) {
  return serverDb
    .select()
    .from(serverItems)
    .where(eq(serverItems.id, id))
    .get();
}

/** A change on the server from a different device, by Alex. */
function serverWrite(request: OpRequest) {
  const node = "4d4d4d4d-0000-4000-8000-000000000000";
  const clock = new HlcClock(node, undefined, realNow);
  const op = opSchema.parse({
    opId: crypto.randomUUID(),
    clientId: node,
    hlc: clock.now(),
    ...request,
  });
  return applyOps(ALEX, "app", [op], { db: serverDb, clock: serverClock });
}

beforeEach(async () => {
  serverDb = createTestDb();
  serverClock = new HlcClock("server", undefined, realNow);
  Object.assign(net, {
    online: true,
    authorized: true,
    pushes: 0,
    pulls: 0,
    failPull: false,
    failPullAt: null,
    pushed: [],
    maxOps: Infinity,
    poison: null,
  });
  db = new ClientDb(`test-${++dbCount}`);
  await resetForUser(db, SAM.id);
});

afterEach(async () => {
  vi.restoreAllMocks();
  serverDb.$client.close();
  db.close();
});

/** A list with one item, synced. */
async function seed() {
  await mutateLocal(db, {
    type: "createList",
    args: { listId: LIST, name: "Whole Foods" },
  });
  await mutateLocal(db, {
    type: "addItem",
    args: { itemId: ITEM, listId: LIST, name: "Milk" },
  });
  await makeEngine().engine.sync();
  net.pushes = 0;
  net.pulls = 0;
}

describe("mutate", () => {
  it("applies a change at once and adds it to the outbox", async () => {
    await mutateLocal(db, {
      type: "createList",
      args: { listId: LIST, name: " Whole Foods " },
    });
    const op = await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM, listId: LIST, name: "Milk" },
    });

    expect(await readList(db, LIST)).toMatchObject({
      list: { name: "Whole Foods", createdBy: SAM.id, seq: 0 },
      items: [{ id: ITEM, name: "Milk", quantity: 1, checked: false }],
    });
    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox.map((e) => e.op.type)).toEqual(["createList", "addItem"]);
    expect(op.clientId).toBe(await getMeta(db, "clientId"));
    // The HLCs increase, and the meta table keeps the last one.
    expect(outbox[0].op.hlc < outbox[1].op.hlc).toBe(true);
    expect(await getMeta(db, "hlc")).toBe(op.hlc);
    // The server has nothing yet.
    expect(serverDb.select().from(serverLists).all()).toEqual([]);
  });

  it("writes nothing for an op that is not valid", async () => {
    await expect(
      mutateLocal(db, { type: "createList", args: { listId: LIST, name: "" } }),
    ).rejects.toThrow();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.lists.count()).toBe(0);
  });
});

describe("sync", () => {
  it("flushes the outbox, and the view matches the server", async () => {
    await seed();
    expect(await db.outbox.count()).toBe(0);
    expect(serverDb.select().from(serverItems).all()).toHaveLength(1);
    expect(await getMeta(db, "cursor")).toBe(2);
    const view = await readList(db, LIST);
    expect(view?.list.seq).toBe(1);
    expect(view?.items[0].seq).toBe(2);
    expect(await db.users.count()).toBe(2);
  });

  it("re-applies the pending ops after a pull", async () => {
    await seed();
    serverWrite({ type: "renameList", args: { listId: LIST, name: "Costco" } });
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });

    // A pull without a push: the check is still pending.
    const res = handlePull(
      new Request("http://localhost/api/sync/pull?since=2"),
      SAM.id,
      { db: serverDb },
    );
    await savePullPage(db, await res.json());
    await rebuildView(db);

    const view = await readList(db, LIST);
    expect(view?.list.name).toBe("Costco");
    expect(view?.items[0].checked).toBe(true);
    expect((await db.serverItems.get(ITEM))?.checked).toBe(false);
    expect(await db.outbox.count()).toBe(1);
  });

  it("reverts a rejected op and sends a rejected event", async () => {
    await seed();
    serverWrite({ type: "deleteList", args: { listId: LIST } });
    await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "Eggs" },
    });
    expect((await readList(db, LIST))?.items).toHaveLength(2);

    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(rejected).toEqual([
      {
        op: expect.objectContaining({ type: "addItem" }),
        reason: "list_deleted",
      },
    ]);
    expect(await db.items.get(ITEM_2)).toBeUndefined();
    expect(await readList(db, LIST)).toBeNull();
    expect(await db.outbox.count()).toBe(0);
  });

  it("drops the local row of a merged add", async () => {
    await seed();
    serverWrite({
      type: "addItem",
      args: { itemId: crypto.randomUUID(), listId: LIST, name: "Eggs" },
    });
    // This device does not have Alex's eggs yet.
    await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "eggs" },
    });

    await makeEngine().engine.sync();

    const names = (await readList(db, LIST))?.items.map((i) => i.name);
    expect(names?.sort()).toEqual(["Eggs", "Milk"]);
    expect(await db.items.get(ITEM_2)).toBeUndefined();
  });

  it("keeps offline writes after a reload and syncs them when online", async () => {
    await seed();
    net.online = false;
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    const offline = makeEngine();
    await offline.engine.sync();
    expect(offline.engine.getStatus().state).toBe("error");
    expect(await db.outbox.count()).toBe(1);

    // A reload: a new connection to the same database, and a new engine.
    const name = db.name;
    db.close();
    db = new ClientDb(name);
    expect(await db.outbox.count()).toBe(1);
    expect((await readList(db, LIST))?.items[0].checked).toBe(true);

    net.online = true;
    const online = makeEngine();
    await online.engine.sync();
    expect(online.engine.getStatus().state).toBe("idle");
    expect(await db.outbox.count()).toBe(0);
    expect(
      serverDb.select().from(serverItems).where(eq(serverItems.id, ITEM)).get()
        ?.checked,
    ).toBe(true);
  });

  it("keeps the outbox on a 401, and syncs after a new sign-in", async () => {
    await seed();
    net.authorized = false;
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    const { engine, timers } = makeEngine();
    await engine.sync();

    expect(engine.getStatus().state).toBe("unauthorized");
    expect(await db.outbox.count()).toBe(1);
    expect((await readList(db, LIST))?.items[0].checked).toBe(true);
    // No retry: it waits for a trigger.
    expect(timers.pending.size).toBe(0);

    net.authorized = true;
    await engine.sync();
    expect(engine.getStatus().state).toBe("idle");
    expect(await db.outbox.count()).toBe(0);
  });

  it("runs one sync at a time", async () => {
    await mutateLocal(db, {
      type: "createList",
      args: { listId: LIST, name: "Target" },
    });
    const { engine } = makeEngine();
    const first = engine.sync();
    const second = engine.sync();
    expect(second).toBe(first);
    await first;
    // The second call made one more run, with an empty outbox.
    expect(net.pushes).toBe(1);
    expect(net.pulls).toBe(2);
  });

  it("backs off after each error and starts again after a success", async () => {
    net.online = false;
    const { engine, timers } = makeEngine();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await engine.sync();
      waits.push([...timers.pending][0].ms);
      timers.pending.clear();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000]);

    net.online = true;
    await engine.sync();
    expect(engine.getStatus()).toMatchObject({ state: "idle" });
    expect(engine.getStatus().lastSyncAt).not.toBeNull();

    net.online = false;
    await engine.sync();
    expect([...timers.pending][0].ms).toBe(1000);
  });

  it("caps the backoff", async () => {
    net.online = false;
    const timers = manualTimers();
    const engine = new SyncEngine({
      db,
      fetch: fakeFetch,
      timers,
      backoffMs: 1000,
      maxBackoffMs: 5000,
    });
    for (let i = 0; i < 5; i++) await engine.sync();
    expect([...timers.pending][0].ms).toBe(5000);
  });

  it("debounces local writes", async () => {
    const { engine, timers } = makeEngine();
    engine.notifyWrite();
    engine.notifyWrite();
    engine.notifyWrite();
    expect([...timers.pending].map((t) => t.ms)).toEqual([300]);
    engine.poke();
    expect([...timers.pending].map((t) => t.ms)).toEqual([0]);
  });

  it("drops an op that is no longer valid, and pushes the others", async () => {
    await mutateLocal(db, {
      type: "createList",
      args: { listId: LIST, name: "Target" },
    });
    // An op from an old app version that the schema now refuses.
    const [entry] = await db.outbox.toArray();
    await db.outbox.add({
      opId: crypto.randomUUID(),
      op: { ...entry.op, opId: crypto.randomUUID(), type: "explode" } as never,
    });

    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(rejected.map((r) => r.reason)).toEqual(["invalid"]);
    expect(await db.outbox.count()).toBe(0);
    expect(serverDb.select().from(serverLists).all()).toHaveLength(1);
  });

  it("pulls all the rows one time, for the summary keys (#143)", async () => {
    await seed();
    expect(await getMeta(db, "summaryKeys")).toBe(true);
    // A device with rows from before #143.
    const old = async () => {
      const row: Partial<ListRecord> = { ...(await db.serverLists.get(LIST)) };
      delete row.summaryKey;
      await db.serverLists.put(row as ListRecord);
    };
    await old();
    await db.meta.delete("summaryKeys");
    await makeEngine().engine.sync();
    expect(await db.serverLists.get(LIST)).toHaveProperty("summaryKey", null);
    expect(await getMeta(db, "summaryKeys")).toBe(true);
    expect((await readList(db, LIST))?.items).toHaveLength(1);

    // Only one time: the next pull starts at the cursor.
    await old();
    await makeEngine().engine.sync();
    expect(await db.serverLists.get(LIST)).not.toHaveProperty("summaryKey");
  });

  it("pulls every page", async () => {
    await seed();
    const ops = Array.from({ length: 600 }, (_, n) => ({
      type: "addItem" as const,
      args: { itemId: crypto.randomUUID(), listId: LIST, name: `Item ${n}` },
    }));
    for (const op of ops) serverWrite(op);

    await makeEngine().engine.sync();
    expect(net.pulls).toBe(2);
    expect((await readList(db, LIST))?.items).toHaveLength(601);
  });

  it("keeps if the server makes summaries (#143)", async () => {
    const page = {
      reset: false,
      lists: [],
      items: [],
      users: [],
      hlc: null,
      cursor: 0,
      hasMore: false,
      purgedSeq: 0,
      now: Date.now(),
    };
    await savePullPage(db, { ...page, summaries: true });
    expect(await getMeta(db, "summaries")).toBe(true);
    // An older server sends no `summaries`.
    await savePullPage(db, page as unknown as PullResponse);
    expect(await getMeta(db, "summaries")).toBe(false);
  });

  it("deletes the server layer on a reset", async () => {
    await seed();
    await savePullPage(db, {
      reset: true,
      lists: [],
      items: [],
      users: [],
      hlc: null,
      cursor: 0,
      hasMore: false,
      purgedSeq: 0,
      summaries: false,
      now: realNow(),
    });
    await rebuildView(db);
    expect(await db.lists.count()).toBe(0);
    expect(await getMeta(db, "cursor")).toBe(0);
  });

  it("keeps the purgedSeq and sends it as seen", async () => {
    await seed();
    const urls: string[] = [];
    const engine = new SyncEngine({
      db,
      timers: manualTimers(),
      fetch: (input, init) => {
        urls.push(String(input));
        return fakeFetch(input, init);
      },
    });
    await engine.sync();
    expect(await getMeta(db, "purgedSeq")).toBe(0);
    expect(urls.at(-1)).toBe("/api/sync/pull?since=2&seen=0");
  });

  it("ends a hung request after the timeout, and tries again", async () => {
    await seed();
    const timers = manualTimers();
    const engine = new SyncEngine({
      db,
      timers,
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    });
    await engine.sync();
    expect(engine.getStatus().state).toBe("error");
    expect([...timers.pending].map((t) => t.ms)).toEqual([1000]);
  });

  it("makes the batch smaller after a 413", async () => {
    await mutateLocal(db, {
      type: "createList",
      args: { listId: LIST, name: "Target" },
    });
    for (let n = 0; n < 120; n++) {
      await mutateLocal(db, {
        type: "addItem",
        args: { itemId: crypto.randomUUID(), listId: LIST, name: `Item ${n}` },
      });
    }
    net.maxOps = 40;
    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(engine.getStatus().state).toBe("idle");
    expect(rejected).toEqual([]);
    expect(await db.outbox.count()).toBe(0);
    expect(serverDb.select().from(serverItems).all()).toHaveLength(120);
  });

  it("finds an op that the server refuses with 400, and drops only it", async () => {
    await mutateLocal(db, {
      type: "createList",
      args: { listId: LIST, name: "Target" },
    });
    const ops: Op[] = [];
    for (let n = 0; n < 9; n++) {
      ops.push(
        await mutateLocal(db, {
          type: "addItem",
          args: {
            itemId: crypto.randomUUID(),
            listId: LIST,
            name: `Item ${n}`,
          },
        }),
      );
    }
    net.poison = ops[6].opId;
    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(engine.getStatus().state).toBe("idle");
    expect(rejected).toEqual([{ op: ops[6], reason: "invalid" }]);
    expect(await db.outbox.count()).toBe(0);
    const names = serverDb
      .select()
      .from(serverItems)
      .all()
      .map((i) => i.name);
    expect(names).toHaveLength(8);
    expect(names).not.toContain("Item 6");
  });

  it("rebuilds the view after a push, also when the pull fails", async () => {
    await seed();
    serverWrite({ type: "deleteList", args: { listId: LIST } });
    await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "Eggs" },
    });
    net.failPull = true;
    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(engine.getStatus().state).toBe("error");
    expect(rejected.map((r) => r.reason)).toEqual(["list_deleted"]);
    expect(await db.outbox.count()).toBe(0);
    // No ghost row of the refused add.
    expect(await db.items.get(ITEM_2)).toBeUndefined();
  });
});

describe("an applied op and a failed pull", () => {
  it("keeps the change in the view until a pull brings it", async () => {
    await seed();
    await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "Eggs" },
    });
    net.failPull = true;
    const { engine } = makeEngine();
    await engine.sync();

    expect(engine.getStatus().state).toBe("error");
    // The server has it, and the view keeps it.
    expect(
      serverDb
        .select()
        .from(serverItems)
        .where(eq(serverItems.id, ITEM_2))
        .get(),
    ).toBeDefined();
    expect(await db.items.get(ITEM_2)).toBeDefined();
    expect(await db.outbox.toArray()).toEqual([
      expect.objectContaining({ acked: true }),
    ]);

    // The next run does not push it again, and the pull removes it.
    net.failPull = false;
    net.pushes = 0;
    await engine.sync();
    expect(net.pushes).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.items.get(ITEM_2))?.name).toBe("Eggs");
  });
});

describe("a device clock that is too far ahead", () => {
  const AHEAD = MAX_DRIFT_MS + 10 * 60_000;

  it("stamps the op again with the server time, and keeps the edit", async () => {
    await seed();
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + AHEAD);
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(rejected).toEqual([]);
    expect(await db.outbox.count()).toBe(0);
    expect(
      serverDb.select().from(serverItems).where(eq(serverItems.id, ITEM)).get()
        ?.checked,
    ).toBe(true);
    expect(net.pushes).toBe(2);
  });

  it("drops the op if the server refuses it again", async () => {
    await seed();
    // The server clock is far behind, thus the new stamp is also refused.
    serverClock = new HlcClock("server", undefined, () => realNow() - AHEAD);
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(rejected.map((r) => r.reason)).toEqual(["clock_ahead"]);
    expect(await db.outbox.count()).toBe(0);
    expect(net.pushes).toBe(2);
  });

  it("starts the clock again from now when the stored HLC is too far ahead", async () => {
    await seed();
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + AHEAD);
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    vi.restoreAllMocks();

    const op = await mutateLocal(db, {
      type: "uncheck",
      args: { itemId: ITEM },
    });
    expect(parse(op.hlc).wall).toBeLessThanOrEqual(realNow());
  });
});

describe("resetForUser", () => {
  it("deletes the local data when a different user signs in", async () => {
    await seed();
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    await resetForUser(db, SAM.id);
    expect(await db.outbox.count()).toBe(1);

    await resetForUser(db, ALEX.id);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.lists.count()).toBe(0);
    expect(await getMeta(db, "cursor")).toBeUndefined();
    expect(await getMeta(db, "userId")).toBe(ALEX.id);
    // The device keeps its client ID and its clock.
    expect(await getMeta(db, "clientId")).toBeDefined();
  });
});

describe("a device clock that is slow (#115)", () => {
  const SLOW = 10 * 60_000;

  it("keeps an edit after a pull of a newer change", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - SLOW);
    await seed();
    expect(await getMeta(db, "clockOffset")).toBeGreaterThan(SLOW - 5000);
    serverWrite({
      type: "updateItem",
      args: { itemId: ITEM, fields: { notes: "Alex" } },
    });
    await makeEngine().engine.sync();
    expect((await db.items.get(ITEM))?.notes).toBe("Alex");

    await mutateLocal(db, {
      type: "updateItem",
      args: { itemId: ITEM, fields: { notes: "Sam" } },
    });
    await makeEngine().engine.sync();
    expect(serverItem(ITEM)?.notes).toBe("Sam");
    expect((await db.items.get(ITEM))?.notes).toBe("Sam");
  });

  it("loadClock compares the stored HLC with the server time", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - SLOW);
    const stored = serialize({ wall: realNow(), counter: 3, node: "x" });
    await setMeta(db, "hlc", stored);

    // With no offset, the stored HLC looks ahead: the clock starts again.
    let { clock } = await loadClock(db);
    expect(parse(clock.now()).wall).toBeLessThan(realNow() - SLOW + 1000);

    // With the offset, it is not ahead: the next HLC sorts after it.
    await setMeta(db, "clockOffset", SLOW);
    ({ clock } = await loadClock(db));
    expect(clock.now() > stored).toBe(true);
  });

  it("loadClock starts again from the server time on a fast device", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + SLOW);
    await setMeta(
      db,
      "hlc",
      serialize({ wall: realNow() + SLOW, counter: 0, node: "x" }),
    );
    await setMeta(db, "clockOffset", -SLOW);
    const { clock } = await loadClock(db);
    const wall = parse(clock.now()).wall;
    expect(Math.abs(wall - realNow())).toBeLessThan(1000);
  });
});

describe("a merged add (#115)", () => {
  const EGGS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  async function addEggs() {
    await seed();
    serverWrite({
      type: "addItem",
      args: { itemId: EGGS, listId: LIST, name: "Eggs" },
    });
    // This device does not have Alex's eggs yet.
    await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "eggs" },
    });
    return mutateLocal(db, {
      type: "updateItem",
      args: { itemId: ITEM_2, fields: { notes: "Brown" } },
    });
  }

  it("applies a later op of the same push to the merged item", async () => {
    const edit = await addEggs();
    const { engine, rejected, merged } = makeEngine();
    await engine.sync();

    expect(rejected).toEqual([]);
    expect(merged.map((m) => m.into)).toEqual([EGGS]);
    expect(serverItem(EGGS)?.notes).toBe("Brown");
    expect(await db.outbox.count()).toBe(0);
    expect((await db.items.get(EGGS))?.notes).toBe("Brown");
    expect(await db.items.get(ITEM_2)).toBeUndefined();
    // The server kept a rejection for the first opId: the op got a new one.
    const again = net.pushed.filter((op) => op.type === "updateItem");
    expect(again.map((op) => op.args)).toEqual([
      { itemId: ITEM_2, fields: { notes: "Brown" } },
      { itemId: EGGS, fields: { notes: "Brown" } },
    ]);
    expect(again[1].opId).not.toBe(edit.opId);
  });

  it("changes the item of a later op in the outbox, and keeps its opId", async () => {
    const edit = await addEggs();
    // Each push has one op.
    net.maxOps = 1;
    const { engine, rejected } = makeEngine();
    await engine.sync();

    expect(rejected).toEqual([]);
    expect(serverItem(EGGS)?.notes).toBe("Brown");
    const pushed = net.pushed.filter((op) => op.type === "updateItem");
    expect(pushed).toEqual([
      expect.objectContaining({
        opId: edit.opId,
        args: { itemId: EGGS, fields: { notes: "Brown" } },
      }),
    ]);
  });

  it("sends the merged event for a duplicate when the first response was lost", async () => {
    await seed();
    serverWrite({
      type: "addItem",
      args: { itemId: EGGS, listId: LIST, name: "Eggs" },
    });
    const add = await mutateLocal(db, {
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "eggs" },
    });
    // The server applied the push, but the response did not arrive.
    await handlePush(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: add.clientId, ops: [add] }),
      }),
      { id: SAM.id },
      { db: serverDb, clock: serverClock, now: realNow },
    );

    const { engine, merged } = makeEngine();
    await engine.sync();
    expect(merged).toEqual([{ op: add, into: EGGS, changed: false }]);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.items.get(ITEM_2)).toBeUndefined();
  });
});

describe("a reset pull (#115)", () => {
  /** 600 items on the server, synced, and a row that the server purged. */
  async function seedMany() {
    await seed();
    for (let n = 0; n < 600; n++) {
      serverWrite({
        type: "addItem",
        args: { itemId: crypto.randomUUID(), listId: LIST, name: `Item ${n}` },
      });
    }
    await makeEngine().engine.sync();
    const gone = { ...(await db.serverItems.get(ITEM))!, id: ITEM_2 };
    await db.serverItems.put(gone);
    await rebuildView(db);
    expect(await db.items.count()).toBe(602);
    // A cursor after the last seq of the server makes a reset.
    await setMeta(db, "cursor", 100_000);
    net.pulls = 0;
  }

  it("keeps the view when page 2 fails", async () => {
    await seedMany();
    net.failPullAt = 2;
    const { engine } = makeEngine();
    await engine.sync();

    expect(engine.getStatus().state).toBe("error");
    expect(net.pulls).toBe(2);
    expect(await db.items.count()).toBe(602);
    expect(await db.serverItems.count()).toBe(602);
    expect(await getMeta(db, "resetting")).toBeDefined();

    // The next run ends the reset. Only then the purged row goes.
    await engine.sync();
    expect(engine.getStatus().state).toBe("idle");
    expect(await db.items.get(ITEM_2)).toBeUndefined();
    expect(await db.items.count()).toBe(601);
    expect(await getMeta(db, "resetting")).toBeUndefined();
  });

  it("deletes the rows that the server does not have after the last page", async () => {
    await seedMany();
    await makeEngine().engine.sync();
    expect(net.pulls).toBe(2);
    expect(await db.serverItems.get(ITEM_2)).toBeUndefined();
    expect(await db.items.count()).toBe(601);
  });
});

describe("the push limit (#115)", () => {
  it("schedules a sync when ops are still pending", async () => {
    await mutateLocal(db, {
      type: "createList",
      args: { listId: LIST, name: "Target" },
    });
    for (let n = 0; n < 120; n++) {
      await mutateLocal(db, {
        type: "addItem",
        args: { itemId: crypto.randomUUID(), listId: LIST, name: `Item ${n}` },
      });
    }
    net.maxOps = 1;
    const { engine, timers } = makeEngine();
    await engine.sync();
    expect(await db.outbox.count()).toBeGreaterThan(0);
    expect([...timers.pending].map((t) => t.ms)).toEqual([0]);

    for (let run = 0; run < 5 && (await db.outbox.count()) > 0; run++) {
      timers.pending.clear();
      await engine.sync();
    }
    expect(await db.outbox.count()).toBe(0);
    expect(serverDb.select().from(serverItems).all()).toHaveLength(120);
    expect(timers.pending.size).toBe(0);
  });
});

describe("resetForUser and an undecided user check (#115)", () => {
  const LIST_2 = "22222222-2222-4222-8222-222222222222";

  it("keeps the ops of the new user", async () => {
    await seed();
    await mutateLocal(db, { type: "check", args: { itemId: ITEM } });
    // The page of Alex made a write before the check.
    await mutateLocal(
      db,
      { type: "createList", args: { listId: LIST_2, name: "Costco" } },
      ALEX.id,
    );

    await resetForUser(db, ALEX.id);
    const outbox = await db.outbox.toArray();
    expect(outbox.map((e) => e.op.type)).toEqual(["createList"]);
    expect(await db.serverLists.count()).toBe(0);
    expect(await db.lists.toArray()).toEqual([
      expect.objectContaining({ id: LIST_2, createdBy: ALEX.id }),
    ]);
    expect(await db.items.count()).toBe(0);
  });
});
