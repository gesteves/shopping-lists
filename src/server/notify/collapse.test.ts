import { describe, expect, it } from "vitest";
import { collapse } from "./collapse";
import { ev } from "@/test/notify-events";

const types = (events: ReturnType<typeof collapse>) =>
  events.map((e) => e.type);

describe("collapse", () => {
  it("cancels a check and an uncheck of one item", () => {
    expect(collapse([ev("check", {}), ev("uncheck", {})])).toEqual([]);
    expect(collapse([ev("uncheck", {}), ev("check", {})])).toEqual([]);
    expect(
      types(collapse([ev("check", {}), ev("uncheck", {}), ev("check", {})])),
    ).toEqual(["check"]);
  });

  it("treats an edit or a move that unchecked as an uncheck (#112)", () => {
    const edit = ev("updateItem", { unchecked: true, fields: ["quantity"] });
    // Check, then an edit that unchecks: only the edit.
    expect(types(collapse([ev("check", {}), edit]))).toEqual(["updateItem"]);
    // An edit of an item that was checked before the burst: only the edit.
    expect(types(collapse([edit]))).toEqual(["updateItem"]);
    // Then a check again: it ends checked, as it started. Only the edit.
    expect(types(collapse([edit, ev("check", {})]))).toEqual(["updateItem"]);
    const move = ev("moveItem", {
      unchecked: true,
      listName: "B",
      fromListName: "A",
    });
    expect(types(collapse([ev("check", {}), move]))).toEqual(["moveItem"]);
  });

  it("cancels an add and a delete, also with changes between them", () => {
    expect(
      collapse([
        ev("addItem", {}),
        ev("check", {}),
        ev("updateItem", {}),
        ev("deleteItem", {}),
      ]),
    ).toEqual([]);
  });

  it("cancels a delete and its undo", () => {
    expect(collapse([ev("deleteItem", {}), ev("restoreItem", {})])).toEqual([]);
    expect(
      collapse([
        ev("deleteList", {}, { itemId: null }),
        ev("restoreList", {}, { itemId: null }),
      ]),
    ).toEqual([]);
  });

  it("keeps an add with an undone delete", () => {
    expect(
      types(
        collapse([
          ev("addItem", {}),
          ev("deleteItem", {}),
          ev("restoreItem", {}),
        ]),
      ),
    ).toEqual(["addItem"]);
  });

  it("folds updates and moves into an add, with the last names", () => {
    const out = collapse([
      ev("addItem", { itemName: "Milk" }),
      ev("updateItem", { itemName: "Oat milk", oldName: "Milk" }),
      ev(
        "moveItem",
        {
          itemName: "Oat milk",
          listName: "Target",
          fromListName: "Whole Foods",
        },
        { listId: "list-2" },
      ),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "addItem",
      listId: "list-2",
      snapshot: { itemName: "Oat milk", listName: "Target" },
    });
  });

  it("keeps a check after an add only if the item ends checked", () => {
    expect(types(collapse([ev("addItem", {}), ev("check", {})]))).toEqual([
      "addItem",
      "check",
    ]);
    expect(
      types(collapse([ev("addItem", {}), ev("check", {}), ev("uncheck", {})])),
    ).toEqual(["addItem"]);
  });

  it("makes one update of many", () => {
    const out = collapse([
      ev("updateItem", { itemName: "Milk 2%", oldName: "Milk" }),
      ev("updateItem", { itemName: "Milk 1%", oldName: "Milk 2%" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].snapshot).toMatchObject({
      itemName: "Milk 1%",
      oldName: "Milk",
    });
  });

  it("keeps the fields of all the updates", () => {
    const out = collapse([
      ev("updateItem", { itemName: "Milk", fields: ["notes"] }),
      ev("updateItem", { itemName: "Milk", fields: ["quantity", "notes"] }),
    ]);
    expect(out[0].snapshot.fields).toEqual(["notes", "quantity"]);
  });

  it("makes one move of many, and cancels a move back", () => {
    const a = { listName: "B", fromListName: "A" };
    const b = { listName: "C", fromListName: "B" };
    const out = collapse([
      ev("moveItem", a, { listId: "b" }),
      ev("moveItem", b, { listId: "c" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].snapshot).toMatchObject({ fromListName: "A", listName: "C" });
    expect(
      collapse([
        ev("moveItem", { listName: "B", fromListName: "A" }, { listId: "b" }),
        ev("moveItem", { listName: "A", fromListName: "B" }, { listId: "a" }),
      ]),
    ).toEqual([]);
  });

  it("says only removed for an item that was changed, then removed", () => {
    expect(types(collapse([ev("check", {}), ev("deleteItem", {})]))).toEqual([
      "deleteItem",
    ]);
  });

  it("drops a list made and deleted in the burst, with its items", () => {
    const L = { listId: "new", itemId: null };
    expect(
      collapse([
        ev("createList", { listName: "Party" }, L),
        ev(
          "addItem",
          { itemName: "Chips" },
          { listId: "new", itemId: "chips" },
        ),
        ev("deleteList", { listName: "Party" }, L),
      ]),
    ).toEqual([]);
  });

  it("folds a rename into a create, and cancels a rename back", () => {
    const L = { listId: "l", itemId: null };
    const out = collapse([
      ev("createList", { listName: "Costco" }, L),
      ev("renameList", { listName: "Sam's Club", oldName: "Costco" }, L),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "createList",
      snapshot: { listName: "Sam's Club" },
    });
    expect(
      collapse([
        ev("renameList", { listName: "B", oldName: "A" }, L),
        ev("renameList", { listName: "A", oldName: "B" }, L),
      ]),
    ).toEqual([]);
  });

  it("keeps bulk events and different items, in order", () => {
    const out = collapse([
      ev("addItem", { itemName: "A" }, { itemId: "a" }),
      ev("clearChecked", { count: 2 }, { itemId: null }),
      ev("check", { itemName: "B" }, { itemId: "b" }),
    ]);
    expect(types(out)).toEqual(["addItem", "clearChecked", "check"]);
  });
});
