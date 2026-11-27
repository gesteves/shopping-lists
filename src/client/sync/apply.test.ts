import { describe, expect, it } from "vitest";
import { serialize } from "@/shared/hlc";
import { opSchema, type OpType } from "@/shared/ops";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import { applyLocal, type LocalState } from "./apply";

const NODE = "5e5e5e5e-0000-4000-8000-000000000000";
const LIST = "11111111-1111-4111-8111-111111111111";
const LIST_2 = "22222222-2222-4222-8222-222222222222";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T = 1_764_000_000_000;
const ME = "user-me";

function op(type: OpType, args: Record<string, unknown>, wall = T) {
  return opSchema.parse({
    opId: crypto.randomUUID(),
    clientId: NODE,
    hlc: serialize({ wall, counter: 0, node: NODE }),
    type,
    args,
  });
}

function list(patch: Partial<ListRecord> = {}): ListRecord {
  return {
    id: LIST,
    name: "Target",
    createdBy: "other",
    createdAt: T - 100,
    updatedBy: "other",
    updatedAt: T - 100,
    updatedVia: "app",
    deletedAt: null,
    summary: null,
    seq: 1,
    ...patch,
  };
}

function item(patch: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: ITEM,
    listId: LIST,
    name: "Milk",
    quantity: 1,
    notes: "",
    checked: false,
    checkedAt: null,
    createdBy: "other",
    createdAt: T - 100,
    updatedBy: "other",
    updatedAt: T - 100,
    updatedVia: "app",
    deletedAt: null,
    seq: 2,
    ...patch,
  };
}

function state(lists: ListRecord[], items: ItemRecord[] = []): LocalState {
  return {
    lists: new Map(lists.map((l) => [l.id, l])),
    items: new Map(items.map((i) => [i.id, i])),
  };
}

describe("applyLocal", () => {
  it("unchecks a checked item on an edit or a move (#112)", () => {
    const checked = { checked: true, checkedAt: T - 50 };
    let s = state([list()], [item(checked)]);
    applyLocal(
      s,
      op("updateItem", { itemId: ITEM, fields: { notes: "2%" } }),
      ME,
    );
    expect(s.items.get(ITEM)).toMatchObject({
      notes: "2%",
      checked: false,
      checkedAt: null,
    });

    s = state([list(), list({ id: LIST_2, name: "Costco" })], [item(checked)]);
    applyLocal(s, op("moveItem", { itemId: ITEM, toListId: LIST_2 }), ME);
    expect(s.items.get(ITEM)).toMatchObject({ listId: LIST_2, checked: false });
  });

  it("does not uncheck on an edit that changes nothing", () => {
    const s = state([list()], [item({ checked: true, checkedAt: T - 50 })]);
    applyLocal(
      s,
      op("updateItem", { itemId: ITEM, fields: { name: "Milk" } }),
      ME,
    );
    expect(s.items.get(ITEM)).toMatchObject({
      checked: true,
      checkedAt: T - 50,
    });
  });

  it("adds an item and stamps it with the user and the op time", () => {
    const s = state([list()]);
    const changed = applyLocal(
      s,
      op("addItem", { itemId: ITEM, listId: LIST, name: "Eggs", quantity: 2 }),
      ME,
    );
    expect([...changed.items]).toEqual([ITEM]);
    expect(s.items.get(ITEM)).toMatchObject({
      name: "Eggs",
      quantity: 2,
      createdBy: ME,
      updatedBy: ME,
      createdAt: T,
      seq: 0,
    });
  });

  it("merges an add into a live item with the same name", () => {
    const s = state([list()], [item({ checked: true, checkedAt: T - 50 })]);
    applyLocal(
      s,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: " MILK " }),
      ME,
    );
    expect(s.items.has(ITEM_2)).toBe(false);
    expect(s.items.get(ITEM)).toMatchObject({ checked: false, updatedBy: ME });
  });

  it("does not merge into a deleted item", () => {
    const s = state([list()], [item({ deletedAt: T - 50 })]);
    applyLocal(
      s,
      op("addItem", { itemId: ITEM_2, listId: LIST, name: "Milk" }),
      ME,
    );
    expect(s.items.has(ITEM_2)).toBe(true);
  });

  it("does nothing for an add or a move to a deleted list", () => {
    const s = state(
      [list(), list({ id: LIST_2, deletedAt: T - 10 })],
      [item()],
    );
    const changed = applyLocal(
      s,
      op("addItem", { itemId: ITEM_2, listId: LIST_2, name: "Eggs" }),
      ME,
    );
    applyLocal(
      s,
      op("moveItem", { itemId: ITEM, toListId: LIST_2 }),
      ME,
      changed,
    );
    expect(changed.items.size).toBe(0);
    expect(s.items.get(ITEM)?.listId).toBe(LIST);
  });

  it("brings back a deleted item on an edit", () => {
    const s = state([list()], [item({ deletedAt: T - 50 })]);
    applyLocal(
      s,
      op("updateItem", { itemId: ITEM, fields: { notes: "2%" } }),
      ME,
    );
    expect(s.items.get(ITEM)).toMatchObject({ notes: "2%", deletedAt: null });
  });

  it("checks with the op time and keeps the first check time", () => {
    const s = state([list()], [item()]);
    applyLocal(s, op("check", { itemId: ITEM }, T), ME);
    applyLocal(s, op("check", { itemId: ITEM }, T + 5), ME);
    expect(s.items.get(ITEM)).toMatchObject({ checked: true, checkedAt: T });
    applyLocal(s, op("uncheck", { itemId: ITEM }, T + 6), ME);
    expect(s.items.get(ITEM)).toMatchObject({
      checked: false,
      checkedAt: null,
    });
  });

  it("clears and unchecks only the checked items of the list", () => {
    const s = state(
      [list()],
      [
        item({ checked: true }),
        item({ id: ITEM_2, name: "Eggs" }),
        item({ id: "x", listId: LIST_2, checked: true }),
      ],
    );
    applyLocal(s, op("clearChecked", { listId: LIST }), ME);
    expect(s.items.get(ITEM)?.deletedAt).toBe(T);
    expect(s.items.get(ITEM_2)?.deletedAt).toBeNull();
    expect(s.items.get("x")?.deletedAt).toBeNull();
  });

  it("checks only the unchecked items of the list", () => {
    const s = state(
      [list()],
      [
        item({ checked: true, checkedAt: T - 9 }),
        item({ id: ITEM_2, name: "Eggs" }),
        item({ id: "x", listId: LIST_2 }),
      ],
    );
    applyLocal(s, op("checkAll", { listId: LIST }), ME);
    expect(s.items.get(ITEM)?.checkedAt).toBe(T - 9);
    expect(s.items.get(ITEM_2)).toMatchObject({ checked: true, checkedAt: T });
    expect(s.items.get("x")?.checked).toBe(false);
  });

  it("renames, deletes, and restores a list", () => {
    const s = state([list()]);
    applyLocal(s, op("renameList", { listId: LIST, name: "Costco" }), ME);
    applyLocal(s, op("deleteList", { listId: LIST }, T + 1), ME);
    expect(s.lists.get(LIST)).toMatchObject({
      name: "Costco",
      deletedAt: T + 1,
    });
    applyLocal(s, op("restoreList", { listId: LIST }, T + 2), ME);
    expect(s.lists.get(LIST)?.deletedAt).toBeNull();
  });
});
