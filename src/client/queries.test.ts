import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("gives the names of a short list in list order, and none for a long list", async () => {
    await db.lists.put(list("l", "Target"));
    await db.items.bulkPut([item("a", 1), item("b", 3), item("c", 2, true)]);
    expect((await readListSummaries(db))[0].names).toEqual(["b", "a"]);

    await db.items.bulkPut([item("d", 4), item("e", 5)]);
    expect((await readListSummaries(db))[0].names).toEqual([]);
  });
});

describe("listLine", () => {
  const summary = (patch: Partial<ListSummary>): ListSummary => ({
    ...list("l", "Target"),
    remaining: 0,
    names: [],
    ...patch,
  });

  it("says that there is nothing to get", () => {
    expect(listLine(summary({ summary: "Old summary" }))).toBe(
      "Nothing to get",
    );
  });

  it("gives the names of a short list", () => {
    expect(
      listLine(
        summary({
          remaining: 3,
          names: ["Milk", "Eggs", "Bread"],
          summary: "x",
        }),
      ),
    ).toBe("Milk, Eggs, and Bread");
    expect(listLine(summary({ remaining: 1, names: ["Milk"] }))).toBe("Milk");
  });

  it("gives the summary of a long list, or the count", () => {
    expect(
      listLine(summary({ remaining: 5, summary: "Produce and milk" })),
    ).toBe("Produce and milk");
    expect(listLine(summary({ remaining: 5 }))).toBe("5 items");
  });
});
