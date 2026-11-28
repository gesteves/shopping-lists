import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import { ClientDb, setMeta } from "./db";
import {
  listLine,
  readList,
  readListSummaries,
  readLists,
  readOtherUserNames,
  splitOlder,
  type ListSummary,
} from "./queries";
import { DAY_MS } from "@/shared/expiry";
import { SUMMARY_WAIT_MS, summaryKeyOf } from "@/shared/summary";

let db: ClientDb;
let n = 0;

beforeEach(() => {
  db = new ClientDb(`queries-${++n}`);
});
afterEach(() => db.close());

const base = {
  outOfStockAt: null,
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
    private: false,
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
    url: "",
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

  it("counts the items that are not deleted, checked or not", async () => {
    await db.lists.bulkPut([list("l", "Target"), list("m", "Costco")]);
    await db.items.bulkPut([
      item("a", 1),
      item("c", 1, true),
      item("d", 1, false, 5),
    ]);
    expect((await readListSummaries(db)).map((l) => [l.name, l.total])).toEqual(
      [
        ["Costco", 0],
        ["Target", 2],
      ],
    );
  });
});

describe("readOtherUserNames", () => {
  it("gives the names of the other users, by name", async () => {
    await db.users.bulkPut([
      { id: "me", name: "Penny", image: null },
      { id: "s", name: "Sam", image: null },
      { id: "a", name: "Alex", image: null },
    ]);
    await setMeta(db, "userId", "me");
    expect(await readOtherUserNames(db)).toEqual(["Alex", "Sam"]);
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

describe("listLine", () => {
  const NOW = 10 * 60_000;
  const summary = (patch: Partial<ListSummary>): ListSummary => ({
    ...list("l", "Target"),
    remaining: 0,
    total: 0,
    names: [],
    summaryFresh: false,
    summaries: true,
    changedAt: NOW,
    ...patch,
  });

  it("says that there is nothing to get", () => {
    expect(listLine(summary({ summary: "Old summary" }), NOW)).toBe(
      "Nothing to get",
    );
  });

  it("gives the name of one item", () => {
    expect(
      listLine(summary({ remaining: 1, names: ["Milk"], summary: "x" }), NOW),
    ).toBe("Milk");
  });

  it("gives a summary for the items now", () => {
    expect(
      listLine(
        summary({
          remaining: 5,
          summary: "Produce and milk",
          summaryFresh: true,
        }),
        NOW,
      ),
    ).toBe("Produce and milk");
  });

  it("waits for a new summary, never the old one (#143)", () => {
    const old = summary({ remaining: 3, summary: "Milk and eggs" });
    // Just changed: a summary can come. Before mount too.
    expect(listLine(old, NOW)).toBeNull();
    expect(listLine(old, null)).toBeNull();
    expect(listLine({ ...old, summary: null }, NOW)).toBeNull();
    // It did not come in time: the count.
    expect(listLine(old, NOW + SUMMARY_WAIT_MS)).toBe("3 items");
    expect(listLine({ ...old, summary: null }, NOW + SUMMARY_WAIT_MS)).toBe(
      "3 items",
    );
  });

  it("gives the count when the server makes no summaries", () => {
    const old = summary({ remaining: 3, summary: "Milk", summaries: false });
    expect(listLine(old, NOW)).toBe("3 items");
    expect(listLine({ ...old, summary: null }, null)).toBe("3 items");
  });
});

describe("readListSummaries summaries (#143)", () => {
  const unchecked = [
    { name: "a", quantity: 1 },
    { name: "b", quantity: 1 },
  ];

  it("knows if the summary is for the unchecked items now", async () => {
    await setMeta(db, "summaries", true);
    await db.lists.put({
      ...list("l", "Target", null, "A and b"),
      summaryKey: await summaryKeyOf(unchecked),
    });
    await db.items.bulkPut([item("a", 1), item("b", 2), item("c", 3, true)]);
    let [row] = await readListSummaries(db);
    expect(row).toMatchObject({ summaryFresh: true, summaries: true });

    // A new item: the summary is old.
    await db.items.put(item("d", 4));
    [row] = await readListSummaries(db);
    expect(row.summaryFresh).toBe(false);

    // Checked off again: the same items as the summary.
    await db.items.put(item("d", 5, true));
    [row] = await readListSummaries(db);
    expect(row.summaryFresh).toBe(true);
  });

  it("is not fresh with no key (a row from an older server)", async () => {
    await db.lists.put(list("l", "Target", null, "A and b"));
    await db.items.bulkPut([item("a", 1), item("b", 2)]);
    const [row] = await readListSummaries(db);
    expect(row).toMatchObject({ summaryFresh: false, summaries: false });
  });

  it("gives the last change of an item, also a delete, in device time", async () => {
    await setMeta(db, "clockOffset", 100);
    await db.lists.put(list("l", "Target"));
    await db.items.bulkPut([item("a", 1_000), item("b", 2_000, false, 3_000)]);
    const [row] = await readListSummaries(db);
    expect(row.changedAt).toBe(3_000 - 100);
  });
});

describe("splitOlder", () => {
  const NOW = new Date(2026, 11, 1, 12).getTime();
  const row = (id: string, checkedDaysAgo: number | null): ItemRecord => ({
    ...base,
    id,
    listId: "l",
    name: id,
    quantity: 1,
    notes: "",
    url: "",
    checked: checkedDaysAgo !== null,
    checkedAt: checkedDaysAgo === null ? null : NOW - checkedDaysAgo * DAY_MS,
    updatedAt: 1,
    deletedAt: null,
  });

  it("moves checked items in their last 15 days to the older part", () => {
    const items = [
      row("open", null),
      row("recent", 3),
      row("older", 16),
      row("oldest", 29),
      row("older-2", 20),
    ];
    const { current, older } = splitOlder(items, NOW);
    expect(current.map((i) => i.id)).toEqual(["open", "recent"]);
    // The delete that comes soonest is last.
    expect(older.map((i) => i.id)).toEqual(["older", "older-2", "oldest"]);
  });

  it("keeps all items in the main part before the time is known", () => {
    const items = [row("open", null), row("oldest", 29)];
    expect(splitOlder(items, null)).toEqual({ current: items, older: [] });
  });
});
