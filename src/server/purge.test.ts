import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { items, lists } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type Op } from "@/shared/ops";
import { SAM, createTestDb } from "@/test/db";
import { activity, processedOps } from "@/db/schema";
import { bus } from "./bus";
import { applyOps, expireCheckedItems } from "./ops";
import {
  EXPIRE_EVERY_MS,
  purgeTombstones,
  runExpiry,
  type PurgeResult,
  FIRST_PURGE_MS,
  KEEP_OPS_DAYS,
  PURGE_AFTER_DAYS,
  PURGE_EVERY_MS,
  runPurge,
  startPurger,
} from "./purge";

const RESULT: PurgeResult = {
  lists: 1,
  items: 2,
  processedOps: 3,
  activity: 4,
  tombstoned: 0,
  purgedSeq: 5,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("purge schedule", () => {
  it("purges after 30 days, a few minutes after boot, then each day", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const purge = vi.fn(() => RESULT);
    const expire = vi.fn(() => 0);
    startPurger(purge, expire);
    // A second start does nothing.
    startPurger(purge, expire);

    vi.advanceTimersByTime(FIRST_PURGE_MS - 1);
    expect(purge).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(PURGE_AFTER_DAYS);
    expect(PURGE_AFTER_DAYS).toBe(30);

    // The expiry runs each hour, the purge each day.
    vi.advanceTimersByTime(EXPIRE_EVERY_MS);
    expect(expire).toHaveBeenCalledTimes(2);
    expect(purge).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PURGE_EVERY_MS - EXPIRE_EVERY_MS);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(expire).toHaveBeenCalledTimes(25);
  });

  it("does not throw when an expiry fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      runExpiry(() => {
        throw new Error("disk full");
      }),
    ).toBeNull();
  });

  it("does not throw when a purge fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      runPurge(() => {
        throw new Error("disk full");
      }),
    ).toBeNull();
  });
});

const NOW = 1_764_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const NODE = "1a1a1a1a-0000-4000-8000-000000000000";
const LIST = "11111111-1111-4111-8111-111111111111";
const LIST_2 = "22222222-2222-4222-8222-222222222222";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("purgeTombstones", () => {
  let db: Db;
  let count = 0;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.$client.close());

  function op(type: string, args: Record<string, unknown>, wall: number): Op {
    count++;
    return opSchema.parse({
      opId: `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`,
      clientId: NODE,
      hlc: serialize({ wall, counter: count % 1000, node: NODE }),
      type,
      args,
    });
  }

  /** Apply ops when the server clock is `serverNow`. */
  function apply(serverNow: number, ...ops: Op[]) {
    return applyOps(SAM, "app", ops, {
      db,
      clock: new HlcClock("server", undefined, () => serverNow),
      now: () => serverNow,
    });
  }

  /** Purge when the server clock is `at`. */
  function purge(at = NOW) {
    return purgeTombstones(30, {
      db,
      clock: new HlcClock("server", undefined, () => at),
      now: () => at,
    });
  }

  const getItem = (id: string) =>
    db.select().from(items).where(eq(items.id, id)).get();
  const getList = (id: string) =>
    db.select().from(lists).where(eq(lists.id, id)).get();

  it("deletes old tombstones, and old deleted lists with their old tombstones", () => {
    const old = NOW - 40 * DAY;
    apply(
      old,
      op("createList", { listId: LIST, name: "Old" }, old),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
      op("deleteItem", { itemId: ITEM }, old + 1),
      op("deleteList", { listId: LIST }, old + 1),
      op("createList", { listId: LIST_2, name: "Current" }, old),
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Eggs" }, old),
      op("addItem", { itemId: ITEM_3, listId: LIST_2, name: "Bread" }, old),
      op("deleteItem", { itemId: ITEM_2 }, old + 1),
    );
    apply(NOW - DAY, op("deleteItem", { itemId: ITEM_3 }, NOW - DAY));
    const purgedItemSeq = getItem(ITEM_2)?.seq;

    const result = purge();

    expect(result).toMatchObject({ lists: 1, items: 2, tombstoned: 0 });
    expect(result.purgedSeq).toBe(purgedItemSeq);
    expect(getList(LIST)).toBeUndefined();
    expect(getItem(ITEM)).toBeUndefined();
    expect(getItem(ITEM_2)).toBeUndefined();
    expect(getItem(ITEM_3)?.deletedAt).not.toBeNull(); // Deleted 1 day ago.
    expect(getList(LIST_2)).toBeDefined();

    // A second run keeps the purged seq.
    expect(purge().purgedSeq).toBe(purgedItemSeq);
  });

  it("makes the live items of an old deleted list tombstones, and deletes them later", () => {
    const old = NOW - 40 * DAY;
    apply(
      old,
      op("createList", { listId: LIST, name: "Old" }, old),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, old),
      op("deleteList", { listId: LIST }, old + 1),
    );
    // An edit of an item in the deleted list gives it a recent seq.
    apply(
      NOW - DAY,
      op("updateItem", { itemId: ITEM, fields: { notes: "2%" } }, NOW - DAY),
    );
    const listSeq = getList(LIST)!.seq;
    const editSeq = getItem(ITEM)!.seq;
    expect(editSeq).toBeGreaterThan(listSeq);

    const pokes: number[] = [];
    const onPoke = ({ seq }: { seq: number }) => pokes.push(seq);
    bus.on("poke", onPoke);
    let result: PurgeResult;
    try {
      result = purge();
    } finally {
      bus.off("poke", onPoke);
    }

    // purged_seq does not go to the seq of the edit: no client resets.
    expect(result).toMatchObject({ lists: 0, items: 0, tombstoned: 2 });
    expect(result.purgedSeq).toBeLessThan(editSeq);
    expect(getList(LIST)?.deletedAt).not.toBeNull();
    const milk = getItem(ITEM)!;
    const eggs = getItem(ITEM_2)!;
    for (const row of [milk, eggs]) {
      expect(row.deletedAt?.getTime()).toBe(NOW);
      expect(row.tombstonedAt?.getTime()).toBe(NOW);
      // The server HLC at the time of the purge.
      expect(row.clocks.deleted).toMatch(
        new RegExp(`^${String(NOW).padStart(15, "0")}-[0-9a-f]{4}-server$`),
      );
    }
    expect(milk.seq).toBeGreaterThan(editSeq);
    expect(eggs.seq).toBeGreaterThan(editSeq);
    expect(pokes).toEqual([Math.max(milk.seq, eggs.seq)]);
    // A second run changes nothing.
    expect(purge()).toMatchObject({ lists: 0, items: 0, tombstoned: 0 });

    // 30 days later, the list and its items go.
    const later = purge(NOW + 31 * DAY);
    expect(later).toMatchObject({ lists: 1, items: 2, tombstoned: 0 });
    expect(later.purgedSeq).toBe(Math.max(milk.seq, eggs.seq));
    expect(getList(LIST)).toBeUndefined();
  });

  it("keeps an old deleted list while one of its tombstones is recent", () => {
    const old = NOW - 40 * DAY;
    apply(
      old,
      op("createList", { listId: LIST, name: "Old" }, old),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
      op("deleteList", { listId: LIST }, old + 1),
    );
    apply(NOW - DAY, op("deleteItem", { itemId: ITEM }, NOW - DAY));
    const result = purge();
    expect(result).toMatchObject({ lists: 0, items: 0, tombstoned: 0 });
    expect(result.purgedSeq).toBe(0);
    expect(getItem(ITEM)?.deletedAt).not.toBeNull();
  });

  it("keeps processed_ops for 180 days, thus an old retry is a duplicate", () => {
    expect(KEEP_OPS_DAYS).toBe(180);
    const old = NOW - 31 * DAY;
    const add = op(
      "addItem",
      { itemId: ITEM, listId: LIST, name: "Milk" },
      old,
    );
    apply(old, op("createList", { listId: LIST, name: "Target" }, old), add);
    apply(old + 1, op("deleteItem", { itemId: ITEM }, old + 1));
    // 31 days later, the purge deletes the item, and keeps the ops.
    expect(purge()).toMatchObject({ items: 1, processedOps: 0 });
    expect(getItem(ITEM)).toBeUndefined();

    // The response of the add was lost. The device sends it again.
    const retry = apply(NOW, add);
    expect(retry.results[0]).toMatchObject({ status: "duplicate" });
    expect(getItem(ITEM)).toBeUndefined();

    // After 180 days, the rows go.
    const rows = db.select().from(processedOps).all().length;
    expect(purge(old + 179 * DAY).processedOps).toBe(0);
    expect(purge(old + 181 * DAY).processedOps).toBe(rows);
  });

  it("keeps a late delete for 30 days from the time the server wrote it", () => {
    const old = NOW - 40 * DAY;
    apply(
      old,
      op("createList", { listId: LIST, name: "Target" }, old),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
    );
    // A device that was offline for 40 days sends its delete now.
    apply(NOW, op("deleteItem", { itemId: ITEM }, old + 1));
    expect(getItem(ITEM)?.deletedAt?.getTime()).toBe(old + 1);
    expect(getItem(ITEM)?.tombstonedAt?.getTime()).toBe(NOW);

    expect(purgeTombstones(30, { db, now: () => NOW }).items).toBe(0);
    expect(purgeTombstones(30, { db, now: () => NOW + 29 * DAY }).items).toBe(
      0,
    );
    expect(purgeTombstones(30, { db, now: () => NOW + 31 * DAY }).items).toBe(
      1,
    );
  });

  it("clears the tombstone time on a restore", () => {
    apply(
      NOW,
      op("createList", { listId: LIST, name: "Target" }, NOW - 3),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, NOW - 3),
      op("deleteItem", { itemId: ITEM }, NOW - 2),
      op("restoreItem", { itemId: ITEM }, NOW - 1),
    );
    expect(getItem(ITEM)).toMatchObject({
      deletedAt: null,
      tombstonedAt: null,
    });
  });

  it("works on a database with no writes", () => {
    expect(purge()).toEqual({
      lists: 0,
      items: 0,
      processedOps: 0,
      activity: 0,
      tombstoned: 0,
      purgedSeq: 0,
    });
  });

  describe("expireCheckedItems", () => {
    const old = NOW - 40 * DAY;

    /** Items checked at different times, by Sam. */
    function seedChecked() {
      apply(
        old,
        op("createList", { listId: LIST, name: "Target" }, old),
        op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
        op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, old),
        op("addItem", { itemId: ITEM_3, listId: LIST, name: "Bread" }, old),
      );
      // Milk: checked 31 days ago. Eggs: 29 days ago. Bread: not checked.
      apply(
        NOW,
        op("check", { itemId: ITEM }, NOW - 31 * DAY),
        op("check", { itemId: ITEM_2 }, NOW - 29 * DAY),
      );
    }

    function expire(at = NOW) {
      return expireCheckedItems({
        db,
        clock: new HlcClock("server", undefined, () => at),
        now: () => at,
      });
    }

    it("deletes only checked items older than 30 days, with a new seq", () => {
      seedChecked();
      const before = getItem(ITEM)!.seq;
      const pokes: number[] = [];
      const onPoke = ({ seq }: { seq: number }) => pokes.push(seq);
      bus.on("poke", onPoke);
      const activityBefore = db.select().from(activity).all().length;
      try {
        expect(expire()).toBe(1);
      } finally {
        bus.off("poke", onPoke);
      }
      const milk = getItem(ITEM)!;
      expect(milk.deletedAt?.getTime()).toBe(NOW);
      expect(milk.tombstonedAt?.getTime()).toBe(NOW);
      expect(milk.seq).toBeGreaterThan(before);
      expect(pokes).toEqual([milk.seq]);
      expect(getItem(ITEM_2)?.deletedAt).toBeNull();
      expect(getItem(ITEM_3)?.deletedAt).toBeNull();
      // No activity rows, thus no notification.
      expect(db.select().from(activity).all()).toHaveLength(activityBefore);
      // A second run deletes nothing.
      expect(expire()).toBe(0);
    });

    it("lets the purge remove the row 30 days later", () => {
      seedChecked();
      expire();
      expect(purgeTombstones(30, { db, now: () => NOW + 29 * DAY }).items).toBe(
        0,
      );
      expect(purgeTombstones(30, { db, now: () => NOW + 31 * DAY }).items).toBe(
        1,
      );
      expect(getItem(ITEM)).toBeUndefined();
    });

    it("keeps the delete against an older uncheck, not a newer one", () => {
      seedChecked();
      expire();
      // An uncheck made offline before the job.
      apply(NOW + 1000, op("uncheck", { itemId: ITEM }, NOW - DAY));
      expect(getItem(ITEM)?.deletedAt).not.toBeNull();
      // An uncheck after the job brings the item back.
      apply(NOW + 2000, op("uncheck", { itemId: ITEM }, NOW + 1500));
      expect(getItem(ITEM)).toMatchObject({ deletedAt: null, checked: false });
    });
  });
});
