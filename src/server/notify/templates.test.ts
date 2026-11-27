import { describe, expect, it } from "vitest";
import { ev } from "@/test/notify-events";
import { article, renderEvent, renderFallback } from "./templates";

const list = { listId: "l", itemId: null };

describe("renderEvent", () => {
  it("gives the exact text for each event", () => {
    const cases: [ReturnType<typeof ev>, string][] = [
      [
        ev("createList", { listName: "Costco" }, list),
        "Sam created a “Costco” list.",
      ],
      [
        ev("createList", { listName: "Aldi" }, list),
        "Sam created an “Aldi” list.",
      ],
      [
        ev("deleteList", { listName: "Target" }, list),
        "Sam deleted the “Target” list.",
      ],
      [
        ev("renameList", { listName: "Costco", oldName: "Sam's Club" }, list),
        "Sam renamed the “Sam's Club” list to “Costco”.",
      ],
      [
        ev("restoreList", { listName: "Target" }, list),
        "Sam restored the “Target” list.",
      ],
      [
        ev("addItem", { itemName: "Milk" }),
        "Sam added “Milk” to the “Whole Foods” list.",
      ],
      [
        ev("updateItem", { itemName: "Milk" }),
        "Sam updated “Milk” in the “Whole Foods” list.",
      ],
      [
        ev("deleteItem", { itemName: "Milk" }),
        "Sam removed “Milk” from the “Whole Foods” list.",
      ],
      [
        ev("restoreItem", { itemName: "Milk" }),
        "Sam put “Milk” back on the “Whole Foods” list.",
      ],
      [
        ev("check", { itemName: "Milk" }),
        "Sam checked “Milk” off the “Whole Foods” list.",
      ],
      [
        ev("uncheck", { itemName: "Milk" }),
        "Sam unchecked “Milk” in the “Whole Foods” list.",
      ],
      [
        ev("moveItem", {
          itemName: "Milk",
          listName: "Target",
          fromListName: "Costco",
        }),
        "Sam moved “Milk” from the “Costco” list to the “Target” list.",
      ],
      [
        ev("clearChecked", { count: 3 }, list),
        "Sam deleted the checked items from the “Whole Foods” list.",
      ],
      [
        ev("uncheckAll", { count: 3 }, list),
        "Sam unchecked everything in the “Whole Foods” list.",
      ],
      [
        ev("checkAll", { count: 3 }, list),
        "Sam checked everything off the “Whole Foods” list.",
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
    ).toBe("Sam (via Claude) added “Eggs” to the “Whole Foods” list.");
  });
});

describe("article", () => {
  it("uses an before a vowel sound", () => {
    for (const name of [
      "Aldi",
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
      "Costco",
      "Target",
      "1 more",
      "110 Main",
      "Whole Foods",
      "  Costco",
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
      "Sam made 2 changes to the “Whole Foods” list.",
    );
    const two = [...one, ev("addItem", { itemName: "C" }, { listId: "l2" })];
    expect(renderFallback(two, "Sam")).toBe("Sam made 3 changes to 2 lists.");
  });
});
