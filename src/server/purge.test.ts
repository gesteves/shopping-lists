import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { items, lists } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type Op } from "@/shared/ops";
import { SAM, createTestDb } from "@/test/db";
import { applyOps } from "./ops";
import {
  purgeTombstones,
  type PurgeResult,
  FIRST_PURGE_MS,
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
    startPurger(purge);
    // A second start does nothing.
    startPurger(purge);

    vi.advanceTimersByTime(FIRST_PURGE_MS - 1);
    expect(purge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(PURGE_AFTER_DAYS);
    expect(PURGE_AFTER_DAYS).toBe(30);

    vi.advanceTimersByTime(PURGE_EVERY_MS);
    expect(purge).toHaveBeenCalledTimes(2);
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
    applyOps(SAM, "app", ops, {
      db,
      clock: new HlcClock("server", undefined, () => serverNow),
      now: () => serverNow,
    });
  }

  const getItem = (id: string) =>
    db.select().from(items).where(eq(items.id, id)).get();
  const getList = (id: string) =>
    db.select().from(lists).where(eq(lists.id, id)).get();

  it("deletes old tombstones and the items of old deleted lists", () => {
    const old = NOW - 40 * DAY;
    apply(
      old,
      op("createList", { listId: LIST, name: "Old" }, old),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
      op("deleteList", { listId: LIST }, old + 1),
      op("createList", { listId: LIST_2, name: "Current" }, old),
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Eggs" }, old),
      op("addItem", { itemId: ITEM_3, listId: LIST_2, name: "Bread" }, old),
      op("deleteItem", { itemId: ITEM_2 }, old + 1),
    );
    apply(NOW - DAY, op("deleteItem", { itemId: ITEM_3 }, NOW - DAY));
    const purgedItemSeq = getItem(ITEM_2)?.seq;

    const result = purgeTombstones(30, { db, now: () => NOW });

    expect(result).toMatchObject({ lists: 1, items: 2 });
    expect(result.purgedSeq).toBe(purgedItemSeq);
    expect(getList(LIST)).toBeUndefined();
    expect(getItem(ITEM)).toBeUndefined();
    expect(getItem(ITEM_2)).toBeUndefined();
    expect(getItem(ITEM_3)?.deletedAt).not.toBeNull(); // Deleted 1 day ago.
    expect(getList(LIST_2)).toBeDefined();

    // A second run keeps the purged seq.
    expect(purgeTombstones(30, { db, now: () => NOW }).purgedSeq).toBe(
      purgedItemSeq,
    );
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
    expect(purgeTombstones(30, { db, now: () => NOW })).toEqual({
      lists: 0,
      items: 0,
      processedOps: 0,
      activity: 0,
      purgedSeq: 0,
    });
  });
});
