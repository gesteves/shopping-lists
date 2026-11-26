import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { activity } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type OpInput } from "@/shared/ops";
import type { PushPayload } from "@/shared/push";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { applyOps } from "../ops";
import { setListMuted } from "../push";
import { MAX_WAIT_MS, Notifier, QUIET_MS } from "./worker";

const LIST = "11111111-1111-4111-8111-111111111111";
const LIST_2 = "22222222-2222-4222-8222-222222222222";
const NODE = "6f6f6f6f-0000-4000-8000-000000000000";

let db: Db;
let now: number;
let sent: { userId: string; payload: PushPayload }[];
let counter = 0;

beforeEach(() => {
  db = createTestDb();
  now = 1_764_000_000_000;
  sent = [];
});
afterEach(() => db.$client.close());

function notifier() {
  return new Notifier({
    db,
    now: () => now,
    send: async (userId, payload) => {
      sent.push({ userId, payload });
    },
  });
}

/** Apply an op by `actor` at the current fake time. */
function act(
  actor: { id: string },
  request: Omit<OpInput, "opId" | "clientId" | "hlc">,
  via: "app" | "mcp" = "app",
) {
  counter++;
  const op = opSchema.parse({
    opId: crypto.randomUUID(),
    clientId: NODE,
    hlc: serialize({ wall: now, counter: counter % 1000, node: NODE }),
    ...request,
  });
  applyOps(actor, via, [op], {
    db,
    clock: new HlcClock("server", undefined, () => now),
    now: () => now,
  });
}

function addItem(name: string, listId = LIST) {
  act(SAM, {
    type: "addItem",
    args: { itemId: crypto.randomUUID(), listId, name },
  } as never);
}

function seedLists() {
  act(SAM, {
    type: "createList",
    args: { listId: LIST, name: "Whole Foods" },
  } as never);
  act(SAM, {
    type: "createList",
    args: { listId: LIST_2, name: "Costco" },
  } as never);
  // Those are sent and done.
  db.update(activity)
    .set({ notifiedAt: new Date(now) })
    .run();
}

describe("Notifier", () => {
  it("waits until the person is quiet for 60 s, then sends one push", async () => {
    seedLists();
    addItem("Milk");
    now += 30_000;
    addItem("Eggs");
    const n = notifier();

    now += QUIET_MS - 1;
    await n.tick();
    expect(sent).toEqual([]);

    now += 1;
    await n.tick();
    expect(sent).toEqual([
      {
        userId: ALEX.id,
        payload: {
          title: "Whole Foods",
          body: "Sam made 2 changes to the “Whole Foods” list",
          url: `/lists/${LIST}`,
          tag: LIST,
        },
      },
    ]);
    expect(
      db.select().from(activity).where(isNull(activity.notifiedAt)).all(),
    ).toEqual([]);

    // Nothing again at the next tick.
    now += QUIET_MS;
    await n.tick();
    expect(sent).toHaveLength(1);
  });

  it("sends after 3 minutes even when the person keeps changing things", async () => {
    seedLists();
    const n = notifier();
    const start = now;
    while (now - start < MAX_WAIT_MS) {
      addItem(`Item ${now}`);
      now += 20_000;
      await n.tick();
      if (sent.length > 0) break;
    }
    expect(sent).toHaveLength(1);
    expect(now - start).toBeGreaterThanOrEqual(MAX_WAIT_MS);
  });

  it("uses the exact template for one change, with via Claude", async () => {
    seedLists();
    act(
      SAM,
      {
        type: "addItem",
        args: { itemId: crypto.randomUUID(), listId: LIST, name: "Eggs" },
      } as never,
      "mcp",
    );
    now += QUIET_MS;
    await notifier().tick();
    expect(sent[0].payload.body).toBe(
      "Sam (via Claude) added “Eggs” to the “Whole Foods” list",
    );
  });

  it("sends nothing when the changes cancel out", async () => {
    seedLists();
    const itemId = crypto.randomUUID();
    act(SAM, {
      type: "addItem",
      args: { itemId, listId: LIST, name: "Eggs" },
    } as never);
    act(SAM, { type: "deleteItem", args: { itemId } } as never);
    now += QUIET_MS;
    await notifier().tick();
    expect(sent).toEqual([]);
    expect(
      db.select().from(activity).where(isNull(activity.notifiedAt)).all(),
    ).toEqual([]);
  });

  it("does not send changes to a muted list", async () => {
    seedLists();
    setListMuted(ALEX.id, LIST, true, db);
    addItem("Milk", LIST);
    addItem("Paper towels", LIST_2);
    now += QUIET_MS;
    await notifier().tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.body).toBe(
      "Sam added “Paper towels” to the “Costco” list",
    );
  });

  it("sends nothing at all when every change is on a muted list", async () => {
    seedLists();
    setListMuted(ALEX.id, LIST, true, db);
    addItem("Milk", LIST);
    now += QUIET_MS;
    await notifier().tick();
    expect(sent).toEqual([]);
  });

  it("sends only to the other person", async () => {
    seedLists();
    addItem("Milk");
    act(ALEX, {
      type: "createList",
      args: { listId: crypto.randomUUID(), name: "Aldi" },
    } as never);
    now += QUIET_MS;
    await notifier().tick();
    expect(sent.map((s) => [s.userId, s.payload.body]).sort()).toEqual(
      [
        [ALEX.id, "Sam added “Milk” to the “Whole Foods” list"],
        [SAM.id, "Alex created an “Aldi” list"],
      ].sort(),
    );
  });

  it("sends pending activity one time after a restart", async () => {
    seedLists();
    addItem("Milk");
    // The server stops before the group is ready.
    await notifier().tick();
    expect(sent).toEqual([]);

    now += QUIET_MS;
    // A new process: a new notifier on the same database.
    const afterRestart = notifier();
    await afterRestart.tick();
    await afterRestart.tick();
    await notifier().tick();
    expect(sent).toHaveLength(1);
  });

  it("marks the rows before it sends, so a failed send is not repeated", async () => {
    seedLists();
    addItem("Milk");
    now += QUIET_MS;
    const failing = new Notifier({
      db,
      now: () => now,
      send: async () => {
        throw new Error("push service down");
      },
    });
    await failing.tick();
    expect(
      db.select().from(activity).where(eq(activity.type, "addItem")).get()
        ?.notifiedAt,
    ).not.toBeNull();
  });
});
