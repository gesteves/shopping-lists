// The re-create toast (#104, #120): one toast and one new list for each
// deleted list. The client database is real (fake-indexeddb); mutate is a
// fake.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "@/copy";
import type { Op } from "@/shared/ops";
import { ClientDb } from "./db";
import { RecreateGroups, recreateFor, recreateMessage } from "./recreate";
import type { OpRequest } from "./sync";

const DELETED = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MOVED = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

let db: ClientDb;
let n = 0;
const mutate = vi.fn(async (request: OpRequest) => request);

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getClientDb: () => db };
});
vi.mock("./sync", () => ({ mutate: (r: OpRequest) => mutate(r) }));

const base = {
  createdBy: "u",
  createdAt: 1,
  updatedBy: "u",
  updatedAt: 1,
  updatedVia: "app" as const,
  deletedAt: null,
  summary: null,
  summaryKey: null,
  private: false,
  seq: 1,
};

beforeEach(async () => {
  mutate.mockClear();
  db = new ClientDb(`recreate-${++n}`);
  await db.serverLists.bulkPut([
    { ...base, id: DELETED, name: "Camping" },
    { ...base, id: OTHER, name: "Hardware" },
  ]);
  await db.items.put({
    ...base,
    id: MOVED,
    listId: OTHER,
    name: "Rope",
    quantity: 1,
    notes: "",
    checked: false,
    checkedAt: null,
    checkedBy: null,
  } as never);
});
afterEach(() => db.close());

function add(name: string, listId = DELETED, quantity = 1): Op {
  return {
    opId: crypto.randomUUID(),
    clientId: CLIENT,
    hlc: `0000000000001-0000-${CLIENT}`,
    type: "addItem",
    args: { itemId: crypto.randomUUID(), listId, name, quantity, notes: "" },
  } as Op;
}

function move(itemId = MOVED, toListId = DELETED): Op {
  return {
    opId: crypto.randomUUID(),
    clientId: CLIENT,
    hlc: `0000000000001-0000-${CLIENT}`,
    type: "moveItem",
    args: { itemId, toListId },
  } as Op;
}

describe("recreateFor", () => {
  it("makes one list for all the ops, and adds or moves each item", async () => {
    const tent = add("Tent", DELETED, 2);
    const recreate = await recreateFor([tent, add("Stove"), move()]);
    expect(recreate?.listName).toBe("Camping");
    expect(recreate?.items).toEqual([
      { name: "Tent", kind: "add" },
      { name: "Stove", kind: "add" },
      { name: "Rope", kind: "move" },
    ]);

    const listId = await recreate!.run();
    const requests = mutate.mock.calls.map(([r]) => r);
    expect(requests).toHaveLength(4);
    expect(requests[0]).toEqual({
      type: "createList",
      args: { listId, name: "Camping", private: false },
    });
    expect(requests.slice(1).map((r) => r.type)).toEqual([
      "addItem",
      "addItem",
      "moveItem",
    ]);
    for (const r of requests.slice(1)) {
      expect(r.args).toMatchObject(
        r.type === "moveItem"
          ? { itemId: MOVED, toListId: listId }
          : { listId },
      );
    }
    // A new item ID; the fields of the add stay.
    expect(requests[1].args).toMatchObject({ name: "Tent", quantity: 2 });
    expect((requests[1].args as { itemId: string }).itemId).not.toBe(
      (tent.args as { itemId: string }).itemId,
    );
  });

  it("counts the same op or the same name one time", async () => {
    const tent = add("Tent");
    const recreate = await recreateFor([
      tent,
      tent,
      add("tent"),
      move(),
      move(),
    ]);
    expect(recreate?.items).toEqual([
      { name: "Tent", kind: "add" },
      { name: "Rope", kind: "move" },
    ]);
  });

  it("is null with no local list, or with no add or move", async () => {
    await db.serverLists.delete(DELETED);
    expect(await recreateFor([add("Tent")])).toBeNull();
    expect(
      await recreateFor([
        { ...add("Tent"), type: "deleteList", args: { listId: OTHER } } as Op,
      ]),
    ).toBeNull();
  });
});

describe("recreateMessage", () => {
  const r = (items: { name: string; kind: "add" | "move" }[]) =>
    recreateMessage({
      listId: DELETED,
      listName: "Camping",
      items,
      run: vi.fn(),
    });

  it("names one item", () => {
    expect(r([{ name: "Tent", kind: "add" }])).toBe(
      copy.toasts.listDeletedAdd("Camping", "Tent"),
    );
    expect(r([{ name: "Rope", kind: "move" }])).toBe(
      copy.toasts.listDeletedMove("Camping", "Rope"),
    );
  });

  it("counts more items", () => {
    expect(
      r([
        { name: "Tent", kind: "add" },
        { name: "Stove", kind: "add" },
      ]),
    ).toBe(copy.toasts.listDeletedMany("Camping", 2, "add"));
    expect(
      r([
        { name: "Tent", kind: "add" },
        { name: "Rope", kind: "move" },
      ]),
    ).toBe(copy.toasts.listDeletedMany("Camping", 2, "mixed"));
    expect(copy.toasts.listDeletedMany("Camping", 3, "add")).toBe(
      "The “Camping” list was deleted, so 3 items weren’t added.",
    );
  });
});

describe("RecreateGroups", () => {
  function setup() {
    const open = new Set<number>();
    let next = 1;
    const shown: string[][] = [];
    const show = vi.fn((recreate: { items: { name: string }[] }) => {
      shown.push(recreate.items.map((i) => i.name));
      open.add(next);
      return next++;
    });
    const showFallback = vi.fn(() => {
      open.add(next);
      return next++;
    });
    const dismiss = vi.fn((id: number) => void open.delete(id));
    const groups = new RecreateGroups({
      show,
      showFallback,
      isShown: (id) => open.has(id),
      dismiss,
      delayMs: 10_000,
    });
    return { groups, show, showFallback, dismiss, shown, open };
  }

  it("shows one toast for the ops of one list, and one for each list", async () => {
    const { groups, show, shown } = setup();
    expect(groups.add(add("Tent"))).toBe(true);
    expect(groups.add(add("Stove"))).toBe(true);
    expect(groups.add(add("Mat"))).toBe(true);
    expect(groups.add(add("Nails", OTHER))).toBe(true);
    await groups.flush();
    expect(show).toHaveBeenCalledTimes(2);
    expect(shown).toEqual([["Tent", "Stove", "Mat"], ["Nails"]]);
  });

  it("waits, then shows the toast", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { groups, show } = setup();
      groups.add(add("Tent"));
      groups.add(add("Stove"));
      expect(show).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces an open toast when more ops of its list come", async () => {
    const { groups, show, dismiss, shown, open } = setup();
    groups.add(add("Tent"));
    await groups.flush();
    groups.add(add("Stove"));
    await groups.flush();
    expect(dismiss).toHaveBeenCalledWith(1);
    expect(shown).toEqual([["Tent"], ["Tent", "Stove"]]);

    // After the toast closes, a new op gets a new group.
    open.clear();
    groups.add(add("Mat"));
    await groups.flush();
    expect(shown.at(-1)).toEqual(["Mat"]);
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("shows one general toast when the list is not on this device", async () => {
    const { groups, show, showFallback } = setup();
    await db.serverLists.delete(DELETED);
    groups.add(add("Tent"));
    groups.add(add("Stove"));
    await groups.flush();
    expect(show).not.toHaveBeenCalled();
    expect(showFallback).toHaveBeenCalledOnce();
  });

  it("refuses an op that is not an add or a move", () => {
    const { groups } = setup();
    expect(
      groups.add({
        ...add("Tent"),
        type: "deleteList",
        args: { listId: DELETED },
      } as Op),
    ).toBe(false);
  });
});
