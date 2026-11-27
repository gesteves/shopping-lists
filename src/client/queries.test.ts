import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summaryKey } from "@/shared/summary";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import { ClientDb } from "./db";
import {
  listLine,
  readList,
  readListSummaries,
  readLists,
  type ListSummary,
} from "./queries";

let db: ClientDb;
let n = 0;

beforeEach(() => {
  db = new ClientDb(`queries-${++n}`);
});
afterEach(() => db.close());

const base = {
  createdBy: "u",
  createdAt: 1,
  updatedBy: "u",
  updatedVia: "app" as const,
  seq: 1,
};

function list(
  id: string,
  name: string,
  deletedAt: number | null = null,
  summary: string | null = null,
) {
  return {
    ...base,
    id,
    name,
    updatedAt: 1,
    deletedAt,
    summary,
    summaryKey: null,
  } satisfies ListRecord;
}

function item(
  id: string,
  updatedAt: number,
  checked = false,
  deletedAt: number | null = null,
): ItemRecord {
  return {
    ...base,
    id,
    listId: "l",
    name: id,
    quantity: 1,
    notes: "",
    checked,
    checkedAt: checked ? updatedAt : null,
    updatedAt,
    deletedAt,
  };
}

describe("readLists", () => {
  it("gives the lists that are not deleted, by name", async () => {
    await db.lists.bulkPut([
      list("a", "target"),
      list("b", "Costco"),
      list("c", "Aldi", 5),
    ]);
    expect((await readLists(db)).map((l) => l.name)).toEqual([
      "Costco",
      "target",
    ]);
  });
});

describe("readList", () => {
  it("sorts unchecked first, then the last updated first", async () => {
    await db.lists.put(list("l", "Target"));
    await db.items.bulkPut([
      item("old", 1),
      item("new", 9),
      item("checked-new", 10, true),
      item("checked-old", 2, true),
      item("deleted", 20, false, 21),
    ]);
    const view = await readList(db, "l");
    expect(view?.items.map((i) => i.id)).toEqual([
      "new",
      "old",
      "checked-new",
      "checked-old",
    ]);
  });

  it("gives null for a deleted or missing list", async () => {
    await db.lists.put(list("l", "Target", 3));
    expect(await readList(db, "l")).toBeNull();
    expect(await readList(db, "missing")).toBeNull();
  });
});

describe("readListSummaries", () => {
  it("counts the items that are not checked and not deleted", async () => {
    await db.lists.bulkPut([list("l", "Target"), list("m", "Costco")]);
    await db.items.bulkPut([
      item("a", 1),
      item("b", 1),
      item("c", 1, true),
      item("d", 1, false, 5),
    ]);
    expect(
      (await readListSummaries(db)).map((l) => [l.name, l.remaining]),
    ).toEqual([
      ["Costco", 0],
      ["Target", 2],
    ]);
  });
});

describe("readListSummaries names", () => {
  it("gives the name of one unchecked item, and none for more", async () => {
    await db.lists.put(list("l", "Target"));
    await db.items.bulkPut([item("a", 1), item("c", 2, true)]);
    expect((await readListSummaries(db))[0].names).toEqual(["a"]);

    await db.items.put(item("b", 3));
    expect((await readListSummaries(db))[0].names).toEqual([]);
  });
});

describe("readListSummaries summary state", () => {
  const keyOf = (...names: string[]) =>
    summaryKey(names.map((name) => ({ name, quantity: 1 })));

  it("is pending when the items are not the items of the summary", async () => {
    await db.meta.put({ key: "summaries", value: true });
    await db.lists.put({ ...list("l", "Target"), summaryKey: keyOf("a") });
    await db.items.bulkPut([item("a", 1), item("b", 2)]);
    expect((await readListSummaries(db))[0]).toMatchObject({
      current: false,
      pending: true,
    });

    await db.lists.update("l", { summaryKey: keyOf("b", "a") });
    expect((await readListSummaries(db))[0]).toMatchObject({
      current: true,
      pending: false,
    });
  });

  it("is never pending when the server makes no summaries", async () => {
    await db.lists.put(list("l", "Target"));
    await db.items.bulkPut([item("a", 1), item("b", 2)]);
    expect((await readListSummaries(db))[0].pending).toBe(false);
    await db.meta.put({ key: "summaries", value: false });
    expect((await readListSummaries(db))[0].pending).toBe(false);
  });

  it("is not pending for one item", async () => {
    await db.meta.put({ key: "summaries", value: true });
    await db.lists.put(list("l", "Target"));
    await db.items.put(item("a", 1));
    expect((await readListSummaries(db))[0].pending).toBe(false);
  });
});

describe("listLine", () => {
  const summary = (patch: Partial<ListSummary>): ListSummary => ({
    ...list("l", "Target"),
    remaining: 0,
    names: [],
    current: false,
    pending: false,
    ...patch,
  });

  it("says that there is nothing to get", () => {
    expect(listLine(summary({ summary: "Old summary" }))).toBe(
      "Nothing to get",
    );
  });

  it("gives the name of one item", () => {
    expect(
      listLine(summary({ remaining: 1, names: ["Milk"], summary: "x" })),
    ).toBe("Milk");
  });

  it("gives the current summary of two or more items, or the count", () => {
    expect(
      listLine(
        summary({ remaining: 5, summary: "Produce and milk", current: true }),
      ),
    ).toBe("Produce and milk");
    expect(listLine(summary({ remaining: 5 }))).toBe("5 items");
    // A failed summary: current, but null.
    expect(listLine(summary({ remaining: 5, current: true }))).toBe("5 items");
    // An old summary is not shown.
    expect(listLine(summary({ remaining: 2, summary: "Milk and eggs" }))).toBe(
      "2 items",
    );
  });
});
