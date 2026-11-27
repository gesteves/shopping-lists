// The client and the server together: the engine's fetch goes to the real
// push and pull handlers, on a temporary SQLite database.
import "fake-indexeddb/auto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { items as serverItems, lists as serverLists } from "@/db/schema";
import { applyOps } from "@/server/ops";
import { handlePull, handlePush } from "@/server/sync";
import { HlcClock, MAX_DRIFT_MS, parse } from "@/shared/hlc";
import { opSchema, type Op } from "@/shared/ops";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { ClientDb, getMeta } from "../db";
import { readList } from "../queries";
import { SyncEngine, type RejectedDetail, type Timers } from "./engine";
import {
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
    return handlePush(
      request,
      { id: SAM.id },
      { db: serverDb, clock: serverClock, now: realNow },
    );
  }
  if (url.pathname === "/api/sync/pull") {
    net.pulls++;
    if (net.failPull) return new Response(null, { status: 500 });
    return handlePull(request, { db: serverDb });
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
  engine.events.addEventListener("rejected", (e) =>
    rejected.push((e as CustomEvent<RejectedDetail>).detail),
  );
  return { engine, timers, rejected };
}

/** A change on the server from a different device, by Alex. */
function serverWrite(request: OpRequest) {
  const node = "4d4d4d4d-0000-4000-8000-000000000000";
  const clock = new HlcClock(node);
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
