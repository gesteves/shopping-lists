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

  describe("out of stock (#131)", () => {
    const mark = () => ev("markOutOfStock", {});
    const unmark = () => ev("markInStock", {});

    it("keeps one mark or one unmark", () => {
      expect(types(collapse([mark()]))).toEqual(["markOutOfStock"]);
      expect(types(collapse([unmark()]))).toEqual(["markInStock"]);
    });

    it("cancels a mark and an unmark, in each order", () => {
      expect(collapse([mark(), unmark()])).toEqual([]);
      expect(collapse([unmark(), mark()])).toEqual([]);
      expect(types(collapse([mark(), unmark(), mark()]))).toEqual([
        "markOutOfStock",
      ]);
    });

    it("treats a check or a move that marked in stock as an unmark", () => {
      // Out of stock, then checked off: only the check.
      expect(types(collapse([mark(), ev("check", { inStock: true })]))).toEqual(
        ["check"],
      );
      // Out of stock, then moved to another store: only the move.
      const move = ev("moveItem", {
        inStock: true,
        listName: "B",
        fromListName: "A",
      });
      expect(types(collapse([mark(), move]))).toEqual(["moveItem"]);
      // A check of an item that was out of stock before the burst.
      expect(types(collapse([ev("check", { inStock: true })]))).toEqual([
        "check",
      ]);
    });

    it("treats a mark that unchecked as an uncheck", () => {
      // Checked off, then out of stock: only the mark.
      expect(
        types(
          collapse([
            ev("check", {}),
            ev("markOutOfStock", { unchecked: true }),
          ]),
        ),
      ).toEqual(["markOutOfStock"]);
      // A checked item from before the burst: the mark, no uncheck.
      expect(
        types(collapse([ev("markOutOfStock", { unchecked: true })])),
      ).toEqual(["markOutOfStock"]);
    });

    it("keeps a mark after an add only if the item ends out of stock", () => {
      expect(types(collapse([ev("addItem", {}), mark()]))).toEqual([
        "addItem",
        "markOutOfStock",
      ]);
      expect(types(collapse([ev("addItem", {}), mark(), unmark()]))).toEqual([
        "addItem",
      ]);
    });

    it("keeps only the names in the snapshot", () => {
      const [out] = collapse([
        ev("markOutOfStock", { itemName: "Milk", unchecked: true }),
      ]);
      expect(out.snapshot).toStrictEqual({
        listName: "Whole Foods",
        itemName: "Milk",
      });
    });
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
    const add = ev("addItem", { itemName: "Milk" });
    const out = collapse([
      add,
      ev("updateItem", {
        itemName: "Oat milk",
        oldName: "Milk",
        fields: ["name"],
      }),
      ev(
        "moveItem",
        {
          itemName: "Oat milk",
          listName: "Target",
          fromListName: "Whole Foods",
          unchecked: true,
        },
        { listId: "list-2" },
      ),
    ]);
    // No oldName, fromListName, fields, or unchecked of the later events.
    expect(out).toEqual([
      {
        ...add,
        listId: "list-2",
        snapshot: { itemName: "Oat milk", listName: "Target" },
      },
    ]);
  });

  it("keeps only the snapshot keys of each type", () => {
    const L = { listId: "l", itemId: null };
    const out = collapse([
      ev("check", { itemName: "Tea", oldName: "x", count: 3 }, { itemId: "t" }),
      ev("clearChecked", { count: 2, itemName: "x" }, L),
      ev("deleteList", { listName: "Old", oldName: "x" }, L),
    ]);
    expect(out.map((e) => e.snapshot)).toEqual([
      { listName: "Whole Foods", itemName: "Tea" },
      { listName: "Whole Foods", count: 2 },
      { listName: "Old" },
    ]);
  });

  it("drops an item that is deleted at the start and at the end", () => {
    expect(
      collapse([
        ev("restoreItem", { itemName: "Milk" }),
        ev("updateItem", {
          itemName: "Oat milk",
          oldName: "Milk",
          fields: ["name"],
        }),
        ev("check", { itemName: "Oat milk" }),
        ev("deleteItem", { itemName: "Oat milk" }),
      ]),
    ).toEqual([]);
  });

  it("keeps a restore with the changes after it", () => {
    const restore = ev("restoreItem", { itemName: "Milk" });
    const check = ev("check", { itemName: "Milk" });
    expect(collapse([restore, check])).toEqual([
      { ...check, snapshot: { listName: "Whole Foods", itemName: "Milk" } },
      { ...restore, snapshot: { listName: "Whole Foods", itemName: "Milk" } },
    ]);
  });

  it("drops a list that is deleted at the start and at the end, with its items", () => {
    const L = { listId: "l", itemId: null };
    expect(
      collapse([
        ev("restoreList", { listName: "Party" }, L),
        ev("renameList", { listName: "Taco night", oldName: "Party" }, L),
        ev("addItem", { itemName: "Chips" }, { listId: "l", itemId: "c" }),
        ev("deleteList", { listName: "Taco night" }, L),
      ]),
    ).toEqual([]);
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
    expect(out.map((e) => e.snapshot)).toEqual([
      { listName: "Whole Foods", itemName: "Milk 1%", oldName: "Milk" },
    ]);
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
    expect(out.map((e) => e.snapshot)).toEqual([
      { fromListName: "A", listName: "C" },
    ]);
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
    expect(out.map((e) => [e.type, e.snapshot])).toEqual([
      ["createList", { listName: "Sam's Club" }],
    ]);
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

  describe("edits that go back (#133)", () => {
    const qty = (from: number, to: number) =>
      ev("updateItem", {
        itemName: "Milk",
        fields: ["quantity"],
        oldQuantity: from,
        quantity: to,
      });
    const notes = (from: string, to: string) =>
      ev("updateItem", {
        itemName: "Milk",
        fields: ["notes"],
        oldNotes: from,
        notes: to,
      });
    const rename = (from: string, to: string) =>
      ev("updateItem", { itemName: to, oldName: from, fields: ["name"] });
    const link = (from: string, to: string) =>
      ev("updateItem", {
        itemName: "Milk",
        fields: ["url"],
        oldUrl: from,
        url: to,
      });

    it("keeps a URL that ends at a new value (#140)", () => {
      const out = collapse([
        link("", "https://a.example"),
        link("https://a.example", "https://b.example"),
      ]);
      expect(out.map((e) => e.snapshot.fields)).toEqual([["url"]]);
      // The URL is only for collapse: it does not go to Claude.
      expect(out[0].snapshot).not.toHaveProperty("url");
    });

    it("cancels a quantity, notes, or name that goes back", () => {
      expect(collapse([qty(1, 2), qty(2, 1)])).toEqual([]);
      expect(collapse([qty(1, 2), qty(2, 3), qty(3, 1)])).toEqual([]);
      expect(collapse([notes("a", "b"), notes("b", "a")])).toEqual([]);
      expect(collapse([notes("", "2%"), notes("2%", "")])).toEqual([]);
      expect(
        collapse([
          link("", "https://a.example"),
          link("https://a.example", ""),
        ]),
      ).toEqual([]);
      expect(
        collapse([rename("Milk", "Oat milk"), rename("Oat milk", "Milk")]),
      ).toEqual([]);
    });

    it("keeps only the fields that changed overall", () => {
      const last = ev("updateItem", {
        itemName: "Milk",
        oldName: "Oat milk",
        fields: ["name"],
      });
      const out = collapse([
        rename("Milk", "Oat milk"),
        qty(1, 2),
        notes("", "2%"),
        notes("2%", ""),
        last,
      ]);
      // The name and the notes went back: no oldName, no name, no notes.
      expect(out).toEqual([
        {
          ...last,
          snapshot: {
            listName: "Whole Foods",
            itemName: "Milk",
            fields: ["quantity"],
          },
        },
      ]);
    });

    it("keeps an edit that ends at a new value", () => {
      const last = qty(2, 3);
      expect(collapse([qty(1, 2), last])).toEqual([
        {
          ...last,
          snapshot: {
            listName: "Whole Foods",
            itemName: "Milk",
            fields: ["quantity"],
          },
        },
      ]);
      // The old name is the name before the first rename.
      const out = collapse([
        qty(1, 2),
        rename("Milk", "Oat milk"),
        rename("Oat milk", "Soy milk"),
      ]);
      expect(out.map((e) => e.snapshot)).toEqual([
        {
          listName: "Whole Foods",
          itemName: "Soy milk",
          oldName: "Milk",
          fields: ["quantity", "name"],
        },
      ]);
    });

    it("keeps the edits of older rows, which have no values", () => {
      const old = (fields?: ("quantity" | "notes")[]) =>
        ev("updateItem", { itemName: "Milk", ...(fields && { fields }) });
      expect(types(collapse([old(["quantity"]), old(["quantity"])]))).toEqual([
        "updateItem",
      ]);
      expect(types(collapse([qty(1, 2), old(["quantity"])]))).toEqual([
        "updateItem",
      ]);
      expect(types(collapse([old(), old()]))).toEqual(["updateItem"]);
      // An old rename back: the name is known, thus nothing.
      expect(
        collapse([rename("Milk", "Oat milk"), rename("Oat milk", "Milk")]),
      ).toEqual([]);
    });

    it("says the uncheck when an edit that unchecked goes back", () => {
      const first = ev("updateItem", {
        itemName: "Milk",
        fields: ["quantity"],
        oldQuantity: 1,
        quantity: 2,
        unchecked: true,
      });
      expect(collapse([first, qty(2, 1)])).toEqual([
        {
          ...first,
          type: "uncheck",
          snapshot: { listName: "Whole Foods", itemName: "Milk" },
        },
      ]);
      // A check after it: the item ends checked, as it started.
      expect(collapse([first, qty(2, 1), ev("check", {})])).toEqual([]);
      // The edit stays: it tells the uncheck.
      expect(types(collapse([first, qty(2, 3)]))).toEqual(["updateItem"]);
    });
  });

  describe("state changes whose event cancels out (#133)", () => {
    it("says the uncheck when a move that unchecked goes back", () => {
      const away = ev(
        "moveItem",
        { listName: "B", fromListName: "A", unchecked: true },
        { listId: "b" },
      );
      const back = ev(
        "moveItem",
        { listName: "A", fromListName: "B" },
        { listId: "a" },
      );
      // The item is unchecked on the first list.
      expect(collapse([away, back])).toEqual([
        { ...away, type: "uncheck", listId: "a", snapshot: { listName: "A" } },
      ]);
    });

    it("says in stock when a move that marked it goes back", () => {
      const away = ev(
        "moveItem",
        { listName: "B", fromListName: "A", inStock: true },
        { listId: "b" },
      );
      const back = ev(
        "moveItem",
        { listName: "A", fromListName: "B" },
        { listId: "a" },
      );
      expect(types(collapse([away, back]))).toEqual(["markInStock"]);
    });

    it("says in stock when a check that marked it is unchecked", () => {
      const check = ev("check", { itemName: "Milk", inStock: true });
      expect(collapse([check, ev("uncheck", { itemName: "Milk" })])).toEqual([
        {
          ...check,
          type: "markInStock",
          snapshot: { listName: "Whole Foods", itemName: "Milk" },
        },
      ]);
    });

    it("says the uncheck when a mark that unchecked is undone", () => {
      expect(
        types(
          collapse([
            ev("markOutOfStock", { unchecked: true }),
            ev("markInStock", {}),
          ]),
        ),
      ).toEqual(["uncheck"]);
    });
  });

  describe("an add of a name that is checked on the list (#133)", () => {
    const merged = () => ev("addItem", { itemName: "Milk", unchecked: true });

    it("counts as an uncheck, and cancels with a check", () => {
      expect(collapse([merged(), ev("check", {})])).toEqual([]);
      expect(collapse([ev("check", {}), merged()])).toEqual([]);
    });

    it("stays an add when the item ends unchecked", () => {
      const add = merged();
      expect(collapse([add])).toEqual([
        { ...add, snapshot: { listName: "Whole Foods", itemName: "Milk" } },
      ]);
    });

    it("is not a new item: a delete after it says removed", () => {
      expect(types(collapse([merged(), ev("deleteItem", {})]))).toEqual([
        "deleteItem",
      ]);
    });
  });

  describe("bulk ops (#133)", () => {
    // An item row of a bulk op.
    const bulk = (
      type: "checkAll" | "uncheckAll" | "clearChecked",
      item: string,
      extra = {},
    ) => ev(type, { itemName: item, ...extra }, { itemId: item });
    const item = (type: Parameters<typeof ev>[0], id: string) =>
      ev(type, { itemName: id }, { itemId: id });

    it("gives one bulk event with the count", () => {
      const first = bulk("checkAll", "milk");
      expect(collapse([first, bulk("checkAll", "eggs")])).toEqual([
        {
          ...first,
          type: "checkAll",
          itemId: null,
          snapshot: { listName: "Whole Foods", count: 2 },
        },
      ]);
    });

    it("cancels a check all and its undo", () => {
      expect(
        collapse([
          bulk("checkAll", "milk"),
          bulk("checkAll", "eggs"),
          item("uncheck", "milk"),
          item("uncheck", "eggs"),
        ]),
      ).toEqual([]);
    });

    it("cancels an uncheck all and its undo", () => {
      expect(
        collapse([
          bulk("uncheckAll", "milk"),
          bulk("uncheckAll", "eggs"),
          item("check", "eggs"),
          item("check", "milk"),
        ]),
      ).toEqual([]);
    });

    it("cancels a delete checked and its undo", () => {
      expect(
        collapse([
          bulk("clearChecked", "milk"),
          bulk("clearChecked", "eggs"),
          item("restoreItem", "milk"),
          item("restoreItem", "eggs"),
        ]),
      ).toEqual([]);
    });

    it("cancels a check all and an uncheck all, in each order", () => {
      expect(
        collapse([bulk("checkAll", "milk"), bulk("uncheckAll", "milk")]),
      ).toEqual([]);
      expect(
        collapse([bulk("uncheckAll", "milk"), bulk("checkAll", "milk")]),
      ).toEqual([]);
      // Eggs was checked before the burst: the uncheck all of eggs stays.
      const eggs = bulk("uncheckAll", "eggs");
      expect(
        collapse([bulk("checkAll", "milk"), bulk("uncheckAll", "milk"), eggs]),
      ).toEqual([
        {
          ...eggs,
          itemId: null,
          snapshot: { listName: "Whole Foods", count: 1 },
        },
      ]);
    });

    it("nets out item events and bulk events per item", () => {
      // Check milk, then uncheck all: only eggs is left.
      const eggs = bulk("uncheckAll", "eggs");
      expect(
        collapse([item("check", "milk"), bulk("uncheckAll", "milk"), eggs]),
      ).toEqual([
        {
          ...eggs,
          itemId: null,
          snapshot: { listName: "Whole Foods", count: 1 },
        },
      ]);
      // Uncheck milk, then check all of milk only: nothing.
      expect(
        collapse([item("uncheck", "milk"), bulk("checkAll", "milk")]),
      ).toEqual([]);
      // Add, check, then delete checked: nothing for the new item.
      expect(
        collapse([
          item("addItem", "milk"),
          item("check", "milk"),
          bulk("clearChecked", "milk"),
        ]),
      ).toEqual([]);
    });

    it("gives the correct count after a partial cancel", () => {
      const first = bulk("checkAll", "milk");
      const out = collapse([
        first,
        bulk("checkAll", "eggs"),
        bulk("checkAll", "bread"),
        item("uncheck", "eggs"),
        item("check", "tea"),
      ]);
      expect(out).toEqual([
        {
          ...first,
          itemId: null,
          snapshot: { listName: "Whole Foods", count: 2 },
        },
        expect.objectContaining({ type: "check", itemId: "tea" }),
      ]);
    });

    it("keeps one bulk event for each type and list, at its first row", () => {
      const out = collapse([
        item("addItem", "tea"),
        bulk("clearChecked", "milk"),
        ev("clearChecked", { itemName: "x" }, { itemId: "x", listId: "l2" }),
        bulk("uncheckAll", "eggs"),
      ]);
      expect(out.map((e) => [e.type, e.listId, e.snapshot])).toEqual([
        ["addItem", "list-1", { listName: "Whole Foods", itemName: "tea" }],
        ["clearChecked", "list-1", { listName: "Whole Foods", count: 1 }],
        ["clearChecked", "l2", { listName: "Whole Foods", count: 1 }],
        ["uncheckAll", "list-1", { listName: "Whole Foods", count: 1 }],
      ]);
    });

    it("keeps the list of the bulk op when the item moves later", () => {
      const out = collapse([
        bulk("checkAll", "milk"),
        ev(
          "moveItem",
          { itemName: "milk", listName: "B", fromListName: "Whole Foods" },
          { itemId: "milk", listId: "b" },
        ),
      ]);
      expect(out.map((e) => [e.type, e.listId])).toEqual([
        ["moveItem", "b"],
        ["checkAll", "list-1"],
      ]);
    });

    it("says in stock when a check all of an out of stock item is undone", () => {
      expect(
        types(
          collapse([
            bulk("checkAll", "milk", { inStock: true }),
            item("uncheck", "milk"),
          ]),
        ),
      ).toEqual(["markInStock"]);
      // Out of stock, check all, then undo: nothing.
      expect(
        collapse([
          item("markOutOfStock", "milk"),
          bulk("checkAll", "milk", { inStock: true }),
          item("uncheck", "milk"),
        ]),
      ).toEqual([]);
    });
  });

  describe("delete, then add the same item again (#133)", () => {
    const del = (extra = {}) =>
      ev(
        "deleteItem",
        { itemName: "Milk", quantity: 1, notes: "", ...extra },
        { itemId: "old" },
      );
    const add = (extra = {}, ids = {}) =>
      ev(
        "addItem",
        { itemName: "Milk", quantity: 1, notes: "", ...extra },
        { itemId: "new", ...ids },
      );

    it("cancels when the name, quantity, notes, and list are the same", () => {
      expect(collapse([del(), add()])).toEqual([]);
      expect(
        collapse([
          del({ url: "https://a.example" }),
          add({ url: "https://a.example" }),
        ]),
      ).toEqual([]);
      // A delete from before #140 has no URL: it is no link.
      expect(collapse([del(), add({ url: "" })])).toEqual([]);
      expect(
        collapse([
          del({ quantity: 2, notes: "2%" }),
          add({ quantity: 2, notes: "2%" }),
        ]),
      ).toEqual([]);
      // An edit of the new item to the same values.
      expect(
        collapse([
          del({ quantity: 2 }),
          add(),
          ev(
            "updateItem",
            {
              itemName: "Milk",
              fields: ["quantity"],
              oldQuantity: 1,
              quantity: 2,
            },
            { itemId: "new" },
          ),
        ]),
      ).toEqual([]);
    });

    it("keeps both when the item is not the same", () => {
      expect(types(collapse([del(), add({ quantity: 2 })]))).toEqual([
        "deleteItem",
        "addItem",
      ]);
      expect(types(collapse([del(), add({ notes: "2%" })]))).toEqual([
        "deleteItem",
        "addItem",
      ]);
      expect(
        types(collapse([del({ url: "" }), add({ url: "https://a.example" })])),
      ).toEqual(["deleteItem", "addItem"]);
      expect(types(collapse([del(), add({ itemName: "milk" })]))).toEqual([
        "deleteItem",
        "addItem",
      ]);
      expect(types(collapse([del(), add({}, { listId: "l2" })]))).toEqual([
        "deleteItem",
        "addItem",
      ]);
    });

    it("keeps both when the state is not the same", () => {
      // The deleted item was checked or out of stock.
      expect(types(collapse([del({ checked: true }), add()]))).toEqual([
        "deleteItem",
        "addItem",
      ]);
      expect(types(collapse([del({ outOfStock: true }), add()]))).toEqual([
        "deleteItem",
        "addItem",
      ]);
      // The new item ends checked.
      expect(
        types(collapse([del(), add(), ev("check", {}, { itemId: "new" })])),
      ).toEqual(["deleteItem", "addItem", "check"]);
      // The old item changed in the burst before the delete.
      expect(
        types(collapse([ev("check", {}, { itemId: "old" }), del(), add()])),
      ).toEqual(["deleteItem", "addItem"]);
      // Changes of the old item that cancel out do not count.
      expect(
        collapse([
          ev("check", {}, { itemId: "old" }),
          ev("uncheck", {}, { itemId: "old" }),
          del(),
          add(),
        ]),
      ).toEqual([]);
    });

    it("keeps both for older rows, which have no values", () => {
      expect(
        types(
          collapse([
            ev("deleteItem", { itemName: "Milk" }, { itemId: "old" }),
            ev("addItem", { itemName: "Milk" }, { itemId: "new" }),
          ]),
        ),
      ).toEqual(["deleteItem", "addItem"]);
    });

    it("cancels one pair for each delete", () => {
      const second = add({}, { itemId: "newer" });
      expect(collapse([del(), add(), second])).toEqual([
        {
          ...second,
          snapshot: { listName: "Whole Foods", itemName: "Milk" },
        },
      ]);
    });
  });
});
