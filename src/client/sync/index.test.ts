// startSync() and mutate() when the user check is not decided (#115). The
// engine, the realtime stream, and presence are fakes.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALEX, SAM } from "@/test/db";
import { ClientDb, getMeta } from "../db";
import { mutateLocal, resetForUser } from "./local";

const LIST = "11111111-1111-4111-8111-111111111111";
const LIST_2 = "22222222-2222-4222-8222-222222222222";

let db: ClientDb;
let dbCount = 0;

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, getClientDb: () => db };
});
vi.mock("../realtime", () => ({ startRealtime: () => () => {} }));
vi.mock("../presence", () => ({
  presenceStore: { set: () => {} },
  startPresence: () => () => {},
}));
vi.mock("./engine", () => ({
  SyncEngine: class {
    start = vi.fn(() => () => {});
    notifyWrite() {}
    poke() {}
  },
}));

/** The user that get-session gives, or null for a server error. */
let sessionUser: string | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      sessionUser === null
        ? new Response(null, { status: 503 })
        : Response.json({ user: { id: sessionUser } }),
    ),
  );
  sessionUser = null;
  vi.resetModules();
  db = new ClientDb(`index-test-${++dbCount}`);
  // Sam used this browser, and has a pending op.
  await resetForUser(db, SAM.id);
  await mutateLocal(db, {
    type: "createList",
    args: { listId: LIST, name: "Sam's list" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});

/** Wait until `check` is true, with real time for IndexedDB. */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out");
}

describe("startSync with a different user", () => {
  it("keeps a write made before the user check, and checks again on a timer", async () => {
    const sync = await import("./index");
    const stop = sync.startSync(ALEX.id);

    // get-session fails while the browser is online. The data stays.
    const op = await sync.mutate({
      type: "createList",
      args: { listId: LIST_2, name: "Costco" },
    });
    expect(await getMeta(db, "userId")).toBe(SAM.id);
    expect(await db.outbox.count()).toBe(2);
    expect((await db.outbox.get({ opId: op.opId }))?.userId).toBe(ALEX.id);

    // The timer checks again, and the session now shows Alex.
    sessionUser = ALEX.id;
    await vi.advanceTimersByTimeAsync(5_000);
    await until(async () => (await getMeta(db, "userId")) === ALEX.id);

    const outbox = await db.outbox.toArray();
    expect(outbox.map((e) => e.opId)).toEqual([op.opId]);
    expect(await db.lists.toArray()).toEqual([
      expect.objectContaining({ id: LIST_2, createdBy: ALEX.id }),
    ]);
    stop();
  });

  it("does not check on a timer while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const sync = await import("./index");
    const stop = sync.startSync(ALEX.id);
    await until(async () => vi.mocked(fetch).mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // The `online` event checks again.
    sessionUser = ALEX.id;
    window.dispatchEvent(new Event("online"));
    await until(async () => (await getMeta(db, "userId")) === ALEX.id);
    expect(await db.outbox.count()).toBe(0);
    stop();
  });
});
