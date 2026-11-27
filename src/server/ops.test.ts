import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { activity, items, lists, processedOps } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type Op, type OpArgs, type OpType } from "@/shared/ops";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { bus } from "./bus";
import { applyOps, purgeTombstones, type Actor } from "./ops";

// Two devices. PHONE < LAPTOP, for the tie test.
const PHONE = "1a1a1a1a-0000-4000-8000-000000000000";
const LAPTOP = "2b2b2b2b-0000-4000-8000-000000000000";
const LIST = "11111111-1111-4111-8111-111111111111";
const LIST_2 = "22222222-2222-4222-8222-222222222222";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** The server time. Each op time below is before it. */
const NOW = 1_764_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
/** Op times, in order. */
const T1 = NOW - 50_000;
const T2 = NOW - 40_000;
const T3 = NOW - 30_000;
const T4 = NOW - 20_000;

let db: Db;
let clock: HlcClock;
let opCount = 0;
let pokes: number[];
const onPoke = ({ seq }: { seq: number }) => pokes.push(seq);

beforeEach(() => {
  db = createTestDb();
  clock = new HlcClock("server", undefined, () => NOW);
  pokes = [];
  bus.on("poke", onPoke);
});

afterEach(() => {
  bus.off("poke", onPoke);
  db.$client.close();
});

function op<T extends OpType>(
  type: T,
  args: Record<string, unknown> & Partial<OpArgs<T>>,
  wall: number,
  node: string = PHONE,
): Op {
  opCount++;
  return opSchema.parse({
    opId: `00000000-0000-4000-8000-${String(opCount).padStart(12, "0")}`,
    clientId: node,
    hlc: serialize({ wall, counter: 0, node }),
    type,
    args,
  });
}

function apply(actor: Actor, ...ops: Op[]) {
  return applyOps(actor, "app", ops, { db, clock, now: () => NOW });
}

function getItem(id = ITEM) {
  return db.select().from(items).where(eq(items.id, id)).get();
}

function getList(id = LIST) {
  return db.select().from(lists).where(eq(lists.id, id)).get();
}

function activityTypes() {
  return db
    .select({ type: activity.type })
    .from(activity)
    .orderBy(activity.id)
    .all()
    .map((r) => r.type);
}

/** A list with one item, "Milk", from Sam at T1. */
function seed() {
  apply(
    SAM,
    op("createList", { listId: LIST, name: "Whole Foods" }, T1),
    op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, T1),
  );
  pokes = [];
}

describe("lists", () => {
  it("creates, renames, deletes, and restores a list", () => {
    const created = apply(
      SAM,
      op("createList", { listId: LIST, name: "Target" }, T1),
    );
    expect(created.results[0]).toMatchObject({
      status: "applied",
      changed: true,
    });
    expect(getList()).toMatchObject({
      name: "Target",
      createdBy: SAM.id,
      updatedBy: SAM.id,
      deletedAt: null,
    });

    apply(ALEX, op("renameList", { listId: LIST, name: "Costco" }, T2));
    expect(getList()).toMatchObject({ name: "Costco", updatedBy: ALEX.id });

    apply(ALEX, op("deleteList", { listId: LIST }, T3));
    expect(getList()?.deletedAt).toEqual(new Date(T3));

    apply(SAM, op("restoreList", { listId: LIST }, T4));
    expect(getList()?.deletedAt).toBeNull();

    const snapshots = db
      .select({ type: activity.type, snapshot: activity.snapshot })
      .from(activity)
      .orderBy(activity.id)
      .all();
    expect(snapshots).toEqual([
      { type: "createList", snapshot: { listName: "Target" } },
      {
        type: "renameList",
        snapshot: { listName: "Costco", oldName: "Target" },
      },
      { type: "deleteList", snapshot: { listName: "Costco" } },
      { type: "restoreList", snapshot: { listName: "Costco" } },
    ]);
  });

  it("rejects a list ID that exists and a list that does not", () => {
    seed();
    const { results } = apply(
      SAM,
      op("createList", { listId: LIST, name: "Again" }, T2),
      op("renameList", { listId: LIST_2, name: "Nope" }, T2),
      op("deleteList", { listId: LIST_2 }, T2),
    );
    expect(results.map((r) => r.status === "rejected" && r.reason)).toEqual([
      "list_exists",
      "list_not_found",
      "list_not_found",
    ]);
  });
});

describe("field-level last-writer-wins", () => {
  it("keeps concurrent edits to different fields, in each order", () => {
    for (const order of ["notes first", "check first"]) {
      db = createTestDb();
      seed();
      const notes = op(
        "updateItem",
        { itemId: ITEM, fields: { notes: "2%" } },
        T2,
      );
      const check = op("check", { itemId: ITEM }, T3, LAPTOP);
      if (order === "notes first") {
        apply(SAM, notes);
        apply(ALEX, check);
      } else {
        apply(ALEX, check);
        apply(SAM, notes);
      }
      expect(getItem(), order).toMatchObject({
        notes: "2%",
        checked: true,
        checkedAt: new Date(T3),
      });
    }
  });

  it("does not let an older offline edit overwrite a newer edit", () => {
    seed();
    apply(
      ALEX,
      op("updateItem", { itemId: ITEM, fields: { name: "Oat milk" } }, T3),
    );
    const late = apply(
      SAM,
      op("updateItem", { itemId: ITEM, fields: { name: "Soy milk" } }, T2),
    );

    expect(late.results[0]).toMatchObject({
      status: "applied",
      changed: false,
    });
    expect(late.seq).toBeNull();
    expect(getItem()).toMatchObject({
      name: "Oat milk",
      nameKey: "oat milk",
      updatedBy: ALEX.id,
    });
    expect(activityTypes()).toEqual(["createList", "addItem", "updateItem"]);
  });

  it("breaks a tie in the same millisecond on the client ID", () => {
    for (const order of ["phone first", "laptop first"]) {
      db = createTestDb();
      seed();
      const phone = op(
        "updateItem",
        { itemId: ITEM, fields: { quantity: 2 } },
        T2,
        PHONE,
      );
      const laptop = op(
        "updateItem",
        { itemId: ITEM, fields: { quantity: 3 } },
        T2,
        LAPTOP,
      );
      if (order === "phone first") apply(SAM, phone, laptop);
      else apply(SAM, laptop, phone);
      expect(getItem()?.quantity, order).toBe(3);
    }
  });

  it("changes only the fields in updateItem", () => {
    seed();
    apply(
      SAM,
      op(
        "updateItem",
        { itemId: ITEM, fields: { name: "Milk", quantity: 4, notes: "" } },
        T2,
      ),
    );
    expect(getItem()).toMatchObject({ name: "Milk", quantity: 4, notes: "" });
    // The activity names only the field that changed (#89).
    const last = db
      .select({ snapshot: activity.snapshot })
      .from(activity)
      .orderBy(desc(activity.id))
      .get();
    expect(last?.snapshot).toEqual({
      listName: "Whole Foods",
      itemName: "Milk",
      fields: ["quantity"],
    });
  });
});

describe("delete vs. edit", () => {
  /** Apply the two ops in each order, and give the two item rows. */
  function bothOrders(first: () => Op, second: () => Op) {
    return [true, false].map((inOrder) => {
      db = createTestDb();
      seed();
      const [a, b] = [first(), second()];
      if (inOrder) {
        apply(SAM, a);
        apply(ALEX, b);
      } else {
        apply(ALEX, b);
        apply(SAM, a);
      }
      const row = getItem();
      return { name: row?.name, deleted: row?.deletedAt !== null };
    });
  }

  it("keeps the item when the edit is later", () => {
    const rows = bothOrders(
      () => op("deleteItem", { itemId: ITEM }, T2),
      () =>
        op(
          "updateItem",
          { itemId: ITEM, fields: { name: "Eggs" } },
          T3,
          LAPTOP,
        ),
    );
    expect(rows).toEqual([
      { name: "Eggs", deleted: false },
      { name: "Eggs", deleted: false },
    ]);
  });

  it("deletes the item when the delete is later", () => {
    const rows = bothOrders(
      () =>
        op(
          "updateItem",
          { itemId: ITEM, fields: { name: "Eggs" } },
          T2,
          LAPTOP,
        ),
      () => op("deleteItem", { itemId: ITEM }, T3),
    );
    expect(rows).toEqual([
      { name: "Eggs", deleted: true },
      { name: "Eggs", deleted: true },
    ]);
  });

  it("keeps a checked item when the check is later than the delete", () => {
    const rows = bothOrders(
      () => op("deleteItem", { itemId: ITEM }, T2),
      () => op("check", { itemId: ITEM }, T3, LAPTOP),
    );
    expect(rows.every((r) => !r.deleted)).toBe(true);
  });

  it("restores an item after a delete, and an older restore does nothing", () => {
    seed();
    apply(SAM, op("deleteItem", { itemId: ITEM }, T2));
    expect(getItem()?.deletedAt).toEqual(new Date(T2));

    apply(SAM, op("restoreItem", { itemId: ITEM }, T3));
    expect(getItem()?.deletedAt).toBeNull();

    apply(ALEX, op("deleteItem", { itemId: ITEM }, T4));
    const old = apply(SAM, op("restoreItem", { itemId: ITEM }, T3 + 1));
    expect(old.results[0]).toMatchObject({ changed: false });
    expect(getItem()?.deletedAt).toEqual(new Date(T4));
  });

  it("brings back a deleted list when a rename is later", () => {
    seed();
    apply(SAM, op("deleteList", { listId: LIST }, T3));
    apply(ALEX, op("renameList", { listId: LIST, name: "Old name" }, T2));
    expect(getList()).toMatchObject({ name: "Old name" });
    expect(getList()?.deletedAt).not.toBeNull();

    apply(ALEX, op("renameList", { listId: LIST, name: "New name" }, T4));
    expect(getList()).toMatchObject({ name: "New name", deletedAt: null });
  });
});

describe("deleted and missing lists", () => {
  it("rejects an add or a move to a deleted list", () => {
    seed();
    apply(
      SAM,
      op("createList", { listId: LIST_2, name: "Target" }, T1),
      op("deleteList", { listId: LIST_2 }, T2),
    );
    const before = activityTypes().length;
    const { results } = apply(
      ALEX,
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Bread" }, T3),
      op("moveItem", { itemId: ITEM, toListId: LIST_2 }, T3),
    );
    expect(results.map((r) => r.status === "rejected" && r.reason)).toEqual([
      "list_deleted",
      "list_deleted",
    ]);
    expect(getItem(ITEM_2)).toBeUndefined();
    expect(getItem()?.listId).toBe(LIST);
    expect(activityTypes()).toHaveLength(before);
  });

  it("rejects an op on a list or an item that does not exist", () => {
    seed();
    const { results } = apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Bread" }, T2),
      op("check", { itemId: ITEM_2 }, T2),
      op("moveItem", { itemId: ITEM, toListId: LIST_2 }, T2),
      op("clearChecked", { listId: LIST_2 }, T2),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Eggs" }, T2),
    );
    expect(results.map((r) => r.status === "rejected" && r.reason)).toEqual([
      "list_not_found",
      "item_not_found",
      "list_not_found",
      "list_not_found",
      "item_exists",
    ]);
  });

  it("moves an item to a different list", () => {
    seed();
    apply(SAM, op("createList", { listId: LIST_2, name: "Target" }, T1));
    apply(ALEX, op("moveItem", { itemId: ITEM, toListId: LIST_2 }, T2));
    expect(getItem()?.listId).toBe(LIST_2);
    const row = db
      .select()
      .from(activity)
      .where(eq(activity.type, "moveItem"))
      .get();
    expect(row).toMatchObject({
      listId: LIST_2,
      itemId: ITEM,
      snapshot: {
        listName: "Target",
        fromListName: "Whole Foods",
        itemName: "Milk",
      },
    });
  });
});

describe("idempotency", () => {
  it("applies the same op one time, in one call or in two", () => {
    seed();
    const check = op("check", { itemId: ITEM }, T2);
    const first = apply(SAM, check, check);
    const again = apply(SAM, check);

    expect(first.results).toEqual([
      { opId: check.opId, status: "applied", changed: true },
      {
        opId: check.opId,
        status: "duplicate",
        original: { opId: check.opId, status: "applied", changed: true },
      },
    ]);
    expect(again.results[0]).toMatchObject({ status: "duplicate" });
    expect(again.seq).toBeNull();
    expect(pokes).toEqual([first.seq]);
    expect(activityTypes()).toEqual(["createList", "addItem", "check"]);
  });

  it("gives the same rejection again", () => {
    const add = op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, T1);
    apply(SAM, add);
    const again = apply(SAM, add);
    expect(again.results[0]).toEqual({
      opId: add.opId,
      status: "duplicate",
      original: {
        opId: add.opId,
        status: "rejected",
        reason: "list_not_found",
      },
    });
  });
});

describe("dedupe on addItem", () => {
  it("merges into a checked item with the same name and unchecks it", () => {
    seed();
    apply(SAM, op("check", { itemId: ITEM }, T2));
    const { results } = apply(
      ALEX,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "  MILK " }, T3),
    );
    expect(results[0]).toMatchObject({
      status: "merged",
      into: ITEM,
      changed: true,
    });
    expect(getItem(ITEM_2)).toBeUndefined();
    expect(getItem()).toMatchObject({
      checked: false,
      checkedAt: null,
      updatedBy: ALEX.id,
    });
    const last = db.select().from(activity).orderBy(activity.id).all().at(-1);
    expect(last).toMatchObject({ type: "addItem", itemId: ITEM });
  });

  it("merges into an unchecked item and changes nothing", () => {
    seed();
    const { results, seq } = apply(
      ALEX,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "milk" }, T2),
    );
    expect(results[0]).toMatchObject({
      status: "merged",
      into: ITEM,
      changed: false,
    });
    expect(seq).toBeNull();
    expect(pokes).toEqual([]);
    expect(activityTypes()).toEqual(["createList", "addItem"]);
  });

  it("does not uncheck an item checked after the add", () => {
    seed();
    apply(SAM, op("check", { itemId: ITEM }, T3));
    const { results } = apply(
      ALEX,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Milk" }, T2),
    );
    expect(results[0]).toMatchObject({ status: "merged", changed: false });
    expect(getItem()?.checked).toBe(true);
  });

  it("merges the second of two adds in one push", () => {
    seed();
    const { results } = apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, T2),
      op("addItem", { itemId: ITEM_3, listId: LIST, name: "eggs" }, T2 + 1),
    );
    expect(results.map((r) => r.status)).toEqual(["applied", "merged"]);
    expect(getItem(ITEM_3)).toBeUndefined();
  });

  it("adds a new row when the match is deleted", () => {
    seed();
    apply(SAM, op("deleteItem", { itemId: ITEM }, T2));
    const { results } = apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Milk" }, T3),
    );
    expect(results[0]).toMatchObject({ status: "applied" });
    expect(getItem(ITEM_2)).toMatchObject({ name: "Milk", deletedAt: null });
  });

  it("adds a new row when the match is on a different list", () => {
    seed();
    apply(SAM, op("createList", { listId: LIST_2, name: "Target" }, T1));
    const { results } = apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Milk" }, T2),
    );
    expect(results[0]).toMatchObject({ status: "applied" });
  });

  it("gives the merge again on a retry", () => {
    seed();
    const add = op(
      "addItem",
      { itemId: ITEM_2, listId: LIST, name: "Milk" },
      T2,
    );
    apply(SAM, add);
    expect(apply(SAM, add).results[0]).toMatchObject({
      status: "duplicate",
      original: { status: "merged", into: ITEM },
    });
  });
});

describe("clearChecked, uncheckAll, and checkAll", () => {
  function seedThree() {
    seed();
    apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, T1),
      op("addItem", { itemId: ITEM_3, listId: LIST, name: "Bread" }, T1),
      op("check", { itemId: ITEM }, T2),
      // Checked after the bulk op below. The bulk op must keep it.
      op("check", { itemId: ITEM_3 }, T4),
    );
  }

  it("clearChecked deletes the items checked before it", () => {
    seedThree();
    const { results } = apply(ALEX, op("clearChecked", { listId: LIST }, T3));
    expect(results[0]).toMatchObject({ status: "applied", changed: true });
    expect(getItem(ITEM)?.deletedAt).toEqual(new Date(T3));
    expect(getItem(ITEM_2)?.deletedAt).toBeNull(); // Not checked.
    expect(getItem(ITEM_3)?.deletedAt).toBeNull(); // Checked later.
    const last = db.select().from(activity).orderBy(activity.id).all().at(-1);
    expect(last).toMatchObject({
      type: "clearChecked",
      itemId: null,
      snapshot: { listName: "Whole Foods", count: 1 },
    });
  });

  it("uncheckAll unchecks the items checked before it", () => {
    seedThree();
    apply(ALEX, op("uncheckAll", { listId: LIST }, T3));
    expect(getItem(ITEM)?.checked).toBe(false);
    expect(getItem(ITEM_3)?.checked).toBe(true);
  });

  it("checkAll checks the items unchecked before it", () => {
    seed();
    apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, T1),
      op("check", { itemId: ITEM_2 }, T2),
      // Unchecked after the bulk op below. The bulk op must keep it.
      op("uncheck", { itemId: ITEM_2 }, T4),
      // Added after the bulk op below. The person did not see it.
      op("addItem", { itemId: ITEM_3, listId: LIST, name: "Bread" }, T4),
    );
    const { results } = apply(ALEX, op("checkAll", { listId: LIST }, T3));
    expect(results[0]).toMatchObject({ status: "applied", changed: true });
    expect(getItem(ITEM)).toMatchObject({
      checked: true,
      checkedAt: new Date(T3),
    });
    expect(getItem(ITEM_2)?.checked).toBe(false);
    expect(getItem(ITEM_3)?.checked).toBe(false);
    const last = db.select().from(activity).orderBy(activity.id).all().at(-1);
    expect(last).toMatchObject({
      type: "checkAll",
      itemId: null,
      snapshot: { listName: "Whole Foods", count: 1 },
    });
  });

  it("checkAll does nothing when all items are checked", () => {
    seed();
    apply(SAM, op("check", { itemId: ITEM }, T2));
    const { results, seq } = apply(SAM, op("checkAll", { listId: LIST }, T3));
    expect(results[0]).toMatchObject({ status: "applied", changed: false });
    expect(seq).toBeNull();
  });

  it("does nothing when no item is checked", () => {
    seed();
    const { results, seq } = apply(
      SAM,
      op("clearChecked", { listId: LIST }, T2),
      op("uncheckAll", { listId: LIST }, T2),
    );
    expect(results.map((r) => r.status === "applied" && r.changed)).toEqual([
      false,
      false,
    ]);
    expect(seq).toBeNull();
  });

  it("rejects a bulk op on a deleted list", () => {
    seed();
    apply(SAM, op("deleteList", { listId: LIST }, T2));
    const { results } = apply(SAM, op("uncheckAll", { listId: LIST }, T3));
    expect(results[0]).toMatchObject({ reason: "list_deleted" });
  });
});

describe("seq and the update fields", () => {
  it("gives each changed row the next seq", () => {
    seed();
    const list = getList();
    const item = getItem();
    expect([list?.seq, item?.seq]).toEqual([1, 2]);

    apply(
      SAM,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, T1),
      op("check", { itemId: ITEM }, T2),
      op("check", { itemId: ITEM_2 }, T2),
    );
    const { seq } = apply(ALEX, op("clearChecked", { listId: LIST }, T3));
    // clearChecked changed two rows: each row has its own seq.
    expect(seq).toBe(7);
    expect([getItem()?.seq, getItem(ITEM_2)?.seq].sort()).toEqual([6, 7]);
  });

  it("sets updated_by, updated_at, and updated_via", () => {
    seed();
    applyOps(ALEX, "mcp", [op("check", { itemId: ITEM }, T2)], {
      db,
      clock,
      now: () => NOW,
    });
    expect(getItem()).toMatchObject({
      createdBy: SAM.id,
      createdAt: new Date(T1),
      updatedBy: ALEX.id,
      updatedAt: new Date(T2),
      updatedVia: "mcp",
    });
    expect(
      db.select().from(activity).where(eq(activity.type, "check")).get(),
    ).toMatchObject({ actorId: ALEX.id, via: "mcp", at: new Date(NOW) });
  });
});

describe("activity and pokes", () => {
  it("happen only for ops that changed a row", () => {
    seed();
    apply(SAM, op("check", { itemId: ITEM }, T3));
    const done = op("uncheck", { itemId: ITEM }, T4);
    apply(SAM, done);
    pokes = [];
    const before = activityTypes();

    const { results, seq } = apply(
      ALEX,
      done, // Duplicate.
      op("check", { itemId: ITEM }, T2), // Older than the uncheck.
      op("renameList", { listId: LIST_2, name: "x" }, T4), // Rejected.
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "milk" }, T4), // Merged, no change.
      op("uncheck", { itemId: ITEM }, T4 + 1), // Already unchecked.
    );
    expect(results.map((r) => r.status)).toEqual([
      "duplicate",
      "applied",
      "rejected",
      "merged",
      "applied",
    ]);
    expect(seq).toBeNull();
    expect(pokes).toEqual([]);
    expect(activityTypes()).toEqual(before);
  });

  it("send one poke after the commit, with the last seq", () => {
    seed();
    const { seq } = apply(
      SAM,
      op("check", { itemId: ITEM }, T2),
      op("updateItem", { itemId: ITEM, fields: { notes: "2%" } }, T2 + 1),
    );
    expect(seq).toBe(4);
    expect(pokes).toEqual([4]);
  });

  it("writes one processed_ops row for each new op", () => {
    seed();
    expect(db.select().from(processedOps).all()).toHaveLength(2);
  });
});

describe("clock drift and errors", () => {
  it("rejects an op that is too far in the future", () => {
    seed();
    const { results } = apply(
      SAM,
      op("check", { itemId: ITEM }, NOW + 10 * 60_000),
    );
    expect(results[0]).toMatchObject({ reason: "clock_ahead" });
    expect(getItem()?.checked).toBe(false);
  });

  it("writes nothing when an op fails with an unexpected error", () => {
    seed();
    const ghost = { id: "no-such-user" };
    expect(() =>
      apply(
        ghost,
        op("check", { itemId: ITEM }, T2),
        op("addItem", { itemId: ITEM_2, listId: LIST, name: "Eggs" }, T2),
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(getItem()?.checked).toBe(false);
    expect(db.select().from(processedOps).all()).toHaveLength(2);
    expect(pokes).toEqual([]);
  });
});

describe("purgeTombstones", () => {
  it("deletes old tombstones and the items of old deleted lists", () => {
    const old = NOW - 40 * DAY;
    apply(
      SAM,
      op("createList", { listId: LIST, name: "Old" }, old),
      op("addItem", { itemId: ITEM, listId: LIST, name: "Milk" }, old),
      op("deleteList", { listId: LIST }, old + 1),
      op("createList", { listId: LIST_2, name: "Current" }, old),
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Eggs" }, old),
      op("addItem", { itemId: ITEM_3, listId: LIST_2, name: "Bread" }, old),
      op("deleteItem", { itemId: ITEM_2 }, old + 1),
      op("deleteItem", { itemId: ITEM_3 }, NOW - DAY),
    );
    const purgedItemSeq = getItem(ITEM_2)?.seq;

    const result = purgeTombstones(30, { db, now: () => NOW });

    expect(result).toMatchObject({ lists: 1, items: 2 });
    expect(result.purgedSeq).toBe(purgedItemSeq);
    expect(getList()).toBeUndefined();
    expect(getItem()).toBeUndefined();
    expect(getItem(ITEM_2)).toBeUndefined();
    expect(getItem(ITEM_3)?.deletedAt).not.toBeNull(); // Deleted 1 day ago.
    expect(getList(LIST_2)).toBeDefined();

    // A second run keeps the purged seq.
    expect(purgeTombstones(30, { db, now: () => NOW }).purgedSeq).toBe(
      purgedItemSeq,
    );
  });

  it("works on a database with no writes", () => {
    expect(purgeTombstones(30, { db, now: () => NOW })).toEqual({
      lists: 0,
      items: 0,
      processedOps: 0,
      activity: 0,
      purgedSeq: 0,
    });
    // The seq counter starts at 1 after a purge.
    seed();
    expect(getList()?.seq).toBe(1);
  });
});
