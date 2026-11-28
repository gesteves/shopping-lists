import { describe, expect, it } from "vitest";
import { ev } from "@/test/notify-events";
import { article, renderEvent, renderFallback } from "./templates";

const list = { listId: "l", itemId: null };

describe("renderEvent", () => {
  it("gives the exact text for each event", () => {
    const cases: [ReturnType<typeof ev>, string][] = [
      [
        ev("createList", { listName: "JojaMart" }, list),
        "Sam created a “JojaMart” list.",
      ],
      [
        ev("createList", { listName: "Adventurer’s Guild" }, list),
        "Sam created an “Adventurer’s Guild” list.",
      ],
      [
        ev("deleteList", { listName: "Oasis" }, list),
        "Sam deleted the “Oasis” list.",
      ],
      [
        ev("renameList", { listName: "JojaMart", oldName: "Sam's Club" }, list),
        "Sam renamed the “Sam's Club” list to “JojaMart”.",
      ],
      [
        ev("restoreList", { listName: "Oasis" }, list),
        "Sam restored the “Oasis” list.",
      ],
      [
        ev("addItem", { itemName: "Milk" }),
        "Sam added “Milk” to the “Pierre’s General Store” list.",
      ],
      [
        ev("updateItem", { itemName: "Milk" }),
        "Sam updated “Milk” in the “Pierre’s General Store” list.",
      ],
      [
        ev("deleteItem", { itemName: "Milk" }),
        "Sam removed “Milk” from the “Pierre’s General Store” list.",
      ],
      [
        ev("restoreItem", { itemName: "Milk" }),
        "Sam put “Milk” back on the “Pierre’s General Store” list.",
      ],
      [
        ev("check", { itemName: "Milk" }),
        "Sam checked “Milk” off the “Pierre’s General Store” list.",
      ],
      [
        ev("uncheck", { itemName: "Milk" }),
        "Sam unchecked “Milk” in the “Pierre’s General Store” list.",
      ],
      [
        ev("moveItem", {
          itemName: "Milk",
          listName: "Oasis",
          fromListName: "JojaMart",
        }),
        "Sam moved “Milk” from the “JojaMart” list to the “Oasis” list.",
      ],
      [
        ev("clearChecked", { count: 3 }, list),
        "Sam deleted the checked items from the “Pierre’s General Store” list.",
      ],
      [
        ev("uncheckAll", { count: 3 }, list),
        "Sam unchecked everything in the “Pierre’s General Store” list.",
      ],
      [
        ev("checkAll", { count: 3 }, list),
        "Sam checked everything off the “Pierre’s General Store” list.",
      ],
      [
        ev("markOutOfStock", { itemName: "Milk" }),
        "Sam marked “Milk” as out of stock in the “Pierre’s General Store” list.",
      ],
      [
        ev("markInStock", { itemName: "Milk" }),
        "Sam marked “Milk” as in stock in the “Pierre’s General Store” list.",
      ],
    ];
    for (const [event, text] of cases)
      expect(renderEvent(event, "Sam")).toBe(text);
  });

  it("adds (via Claude) for an MCP change", () => {
    expect(
      renderEvent(
        ev("addItem", { itemName: "Eggs" }, {}, { via: "mcp" }),
        "Sam",
      ),
    ).toBe(
      "Sam (via Claude) added “Eggs” to the “Pierre’s General Store” list.",
    );
  });
});

describe("article", () => {
  it("uses an before a vowel sound", () => {
    for (const name of [
      "Adventurer’s Guild",
      "Oasis",
      "eggs",
      "IKEA",
      "Office",
      "urgent",
      "8th Street",
      "11 things",
      "18 Wheels",
      "800 Market",
    ]) {
      expect(article(name), name).toBe("an");
    }
    for (const name of [
      "JojaMart",
      "Blacksmith",
      "1 more",
      "110 Main",
      "Pierre’s General Store",
      "  JojaMart",
    ]) {
      expect(article(name), name).toBe("a");
    }
  });
});

describe("renderFallback", () => {
  it("counts the changes and names the list, or counts the lists", () => {
    const one = [
      ev("addItem", { itemName: "A" }),
      ev("check", { itemName: "B" }),
    ];
    expect(renderFallback(one, "Sam")).toBe(
      "Sam made 2 changes to the “Pierre’s General Store” list.",
    );
    const two = [...one, ev("addItem", { itemName: "C" }, { listId: "l2" })];
    expect(renderFallback(two, "Sam")).toBe("Sam made 3 changes to 2 lists.");
  });
});
