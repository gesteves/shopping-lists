import { eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { activity } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type OpInput } from "@/shared/ops";
import type { PushPayload } from "@/shared/push";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { applyOps, expireCheckedItems } from "../ops";
import { saveSubscription, setListMuted } from "../push";
import { MAX_INPUT_CHANGES, summaryInput } from "./summarize";
import type { ActivityEvent } from "./types";
import {
  MAX_WAIT_MS,
  Notifier,
  QUIET_MS,
  pendingActivity,
  type NotifierOptions,
} from "./worker";

const ALLOWED = `${SAM.email},${ALEX.email}`;

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

function notifier(options: NotifierOptions = {}) {
  return new Notifier({
    db,
    now: () => now,
    allowlist: ALLOWED,
    send: async (userId, payload) => {
      sent.push({ userId, payload });
    },
    canPush: () => true,
    ...options,
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
    args: { listId: LIST, name: "Pierre’s General Store" },
  } as never);
  act(SAM, {
    type: "createList",
    args: { listId: LIST_2, name: "JojaMart" },
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
          title: "Pierre’s General Store",
          body: "Sam made 2 changes to the “Pierre’s General Store” list.",
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
      "Sam (via Claude) added “Eggs” to the “Pierre’s General Store” list.",
    );
  });

  it("gives one change to the summarizer too", async () => {
    seedLists();
    addItem("Eggs");
    now += QUIET_MS;
    const seen: number[] = [];
    await new Notifier({
      db,
      now: () => now,
      allowlist: ALLOWED,
      send: async (userId, payload) => {
        sent.push({ userId, payload });
      },
      canPush: () => true,
      summarize: async (events) => {
        seen.push(events.length);
        return "Sam added eggs to the “Pierre’s General Store” list.";
      },
    }).tick();
    expect(seen).toEqual([1]);
    expect(sent[0].payload.body).toBe(
      "Sam added eggs to the “Pierre’s General Store” list.",
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

  describe("pairs that cancel out (#133)", () => {
    const MILK = crypto.randomUUID();
    const EGGS = crypto.randomUUID();
    const BREAD = crypto.randomUUID();
    const op = (type: string, args: Record<string, unknown>) => {
      now += 1000;
      act(SAM, { type, args } as never);
    };

    /** Milk (checked), eggs, and bread, sent and done. */
    function seedItems() {
      seedLists();
      op("addItem", { itemId: MILK, listId: LIST, name: "Milk" });
      op("addItem", {
        itemId: EGGS,
        listId: LIST,
        name: "Eggs",
        notes: "Large",
      });
      op("addItem", { itemId: BREAD, listId: LIST, name: "Bread" });
      op("check", { itemId: MILK });
      db.update(activity)
        .set({ notifiedAt: new Date(now) })
        .run();
    }

    it("sends no push and makes no Claude call for a burst of only such pairs", async () => {
      seedItems();
      // An edit that goes back.
      op("updateItem", { itemId: EGGS, fields: { quantity: 2 } });
      op("updateItem", {
        itemId: EGGS,
        fields: { quantity: 1, notes: "Small" },
      });
      op("updateItem", { itemId: EGGS, fields: { notes: "Large" } });
      op("updateItem", { itemId: BREAD, fields: { name: "Rye bread" } });
      op("updateItem", { itemId: BREAD, fields: { name: "Bread" } });
      // Check all, then its undo.
      op("checkAll", { listId: LIST });
      op("uncheck", { itemId: EGGS });
      op("uncheck", { itemId: BREAD });
      // Uncheck all, then its undo.
      op("uncheckAll", { listId: LIST });
      op("check", { itemId: MILK });
      // Delete checked, then its undo.
      op("clearChecked", { listId: LIST });
      op("restoreItem", { itemId: MILK });
      // Check eggs, then uncheck all.
      op("check", { itemId: EGGS });
      op("uncheckAll", { listId: LIST });
      op("check", { itemId: MILK });
      // An add of a checked name, then a check.
      op("addItem", {
        itemId: crypto.randomUUID(),
        listId: LIST,
        name: "milk",
      });
      op("check", { itemId: MILK });
      // Delete bread, then add it again.
      op("deleteItem", { itemId: BREAD });
      op("addItem", {
        itemId: crypto.randomUUID(),
        listId: LIST,
        name: "Bread",
      });
      // Out of stock, then in stock.
      op("markOutOfStock", { itemId: EGGS });
      op("markInStock", { itemId: EGGS });

      now += QUIET_MS;
      const summarize = vi.fn(async () => "Sam made changes.");
      await notifier({ summarize }).tick();
      expect(summarize).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(pendingActivity(db).all()).toEqual([]);
    });

    it("gives the correct count after a partial cancel", async () => {
      seedItems();
      op("checkAll", { listId: LIST });
      op("uncheck", { itemId: EGGS });
      op("updateItem", { itemId: MILK, fields: { quantity: 3 } });
      now += QUIET_MS;
      const seen: ActivityEvent[][] = [];
      await notifier({
        summarize: async (events) => {
          seen.push(events);
          return "Sam checked off bread.";
        },
      }).tick();
      expect(seen.map((events) => summaryInput(events, "Sam").changes)).toEqual(
        [
          [
            { type: "checkAll", list: "Pierre’s General Store", count: 1 },
            {
              type: "updateItem",
              list: "Pierre’s General Store",
              item: "Milk",
              fields: ["quantity"],
            },
          ],
        ],
      );
    });
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
      "Sam added “Paper towels” to the “JojaMart” list.",
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

  it("sends nothing for a change of the server itself (#152)", async () => {
    const start = now;
    now -= 31 * 24 * 60 * 60 * 1000;
    seedLists();
    const itemId = crypto.randomUUID();
    act(SAM, {
      type: "addItem",
      args: { itemId, listId: LIST, name: "Milk" },
    } as never);
    act(SAM, { type: "check", args: { itemId } } as never);
    db.update(activity)
      .set({ notifiedAt: new Date(now) })
      .run();
    now = start;
    expect(
      expireCheckedItems({
        db,
        clock: new HlcClock("server", undefined, () => now),
        now: () => now,
      }),
    ).toBe(1);
    // Also a system row that is not marked as sent.
    db.update(activity)
      .set({ notifiedAt: null })
      .where(eq(activity.via, "system"))
      .run();
    const n = notifier();
    now += MAX_WAIT_MS + QUIET_MS;
    await n.tick();
    expect(sent).toEqual([]);
  });

  it("sends only to the other person", async () => {
    seedLists();
    addItem("Milk");
    act(ALEX, {
      type: "createList",
      args: { listId: crypto.randomUUID(), name: "Adventurer’s Guild" },
    } as never);
    now += QUIET_MS;
    await notifier().tick();
    expect(sent.map((s) => [s.userId, s.payload.body]).sort()).toEqual(
      [
        [ALEX.id, "Sam added “Milk” to the “Pierre’s General Store” list."],
        [SAM.id, "Alex created an “Adventurer’s Guild” list."],
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

  it("sends nothing to a user who is no longer allowed", async () => {
    seedLists();
    addItem("Milk");
    now += QUIET_MS;
    await notifier({ allowlist: SAM.email }).tick();
    expect(sent).toEqual([]);
    // The rows are marked: a later allowlist change does not send them.
    expect(
      db.select().from(activity).where(isNull(activity.notifiedAt)).all(),
    ).toEqual([]);
  });

  it("sends one push for a large burst", async () => {
    seedLists();
    for (let n = 0; n < 1200; n++) addItem(`Item ${n}`);
    now += QUIET_MS;
    const inputs: ActivityEvent[][] = [];
    await notifier({
      summarize: async (events, name) => {
        inputs.push(events);
        // The model input stays small.
        const input = summaryInput(events, name);
        expect(input.changes).toHaveLength(MAX_INPUT_CHANGES);
        expect(input.more).toEqual({
          count: 1200 - MAX_INPUT_CHANGES,
          types: { addItem: 1200 - MAX_INPUT_CHANGES },
        });
        return "Sam added 1200 items.";
      },
    }).tick();

    expect(inputs).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(
      db.select().from(activity).where(isNull(activity.notifiedAt)).all(),
    ).toEqual([]);
  });

  describe("with no push target", () => {
    const VAPID_ENV = {
      VAPID_PUBLIC_KEY: "pub",
      VAPID_PRIVATE_KEY: "priv",
      VAPID_SUBJECT: "https://x.test",
    };
    afterEach(() => vi.unstubAllEnvs());

    function stubVapid() {
      for (const [key, value] of Object.entries(VAPID_ENV))
        vi.stubEnv(key, value);
    }

    function subscribeAlex() {
      saveSubscription(
        ALEX.id,
        {
          endpoint: "https://fcm.googleapis.com/fcm/send/alex",
          keys: { p256dh: "p", auth: "a" },
          deviceLabel: null,
        },
        db,
      );
    }

    async function run() {
      seedLists();
      addItem("Milk");
      now += QUIET_MS;
      const summarize = vi.fn(async () => "Sam added milk.");
      // The default canPush: VAPID keys and the devices in the database.
      await notifier({ canPush: undefined, summarize }).tick();
      return summarize;
    }

    it("makes no Claude call when the recipient has no enabled device", async () => {
      stubVapid();
      const summarize = await run();
      expect(summarize).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      // The rows are marked: they do not wait for a device.
      expect(
        db.select().from(activity).where(isNull(activity.notifiedAt)).all(),
      ).toEqual([]);
    });

    it("makes no Claude call when there are no VAPID keys", async () => {
      for (const key of Object.keys(VAPID_ENV)) vi.stubEnv(key, "");
      subscribeAlex();
      const summarize = await run();
      expect(summarize).not.toHaveBeenCalled();
    });

    it("calls Claude when the recipient has an enabled device", async () => {
      stubVapid();
      subscribeAlex();
      const summarize = await run();
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
    });
  });

  it("reads the pending rows through activity_pending_idx", () => {
    const query = pendingActivity(db).toSQL();
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...query.params) as { detail: string }[];
    expect(plan.map((p) => p.detail)).toEqual([
      "SCAN activity USING INDEX activity_pending_idx",
    ]);
  });

  it("logs an error in a tick, and does not throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    seedLists();
    addItem("Milk");
    now += QUIET_MS;
    const n = notifier();
    db.$client.close();
    await expect(n.tick()).resolves.toBeUndefined();
    expect(error.mock.calls[0][0]).toMatch(
      /^error \[notify\] tick failed err=\w+\n/,
    );
    error.mockRestore();
    db = createTestDb();
  });
});
