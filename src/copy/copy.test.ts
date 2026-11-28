import { describe, expect, it } from "vitest";
import { copy, locale } from "./index";
import { pluralFor } from "./plural";

describe("pluralFor", () => {
  it("uses the English rules: one and other", () => {
    const plural = pluralFor("en");
    const forms = { one: "1 item", other: "many items" };
    expect(plural(1, forms)).toBe("1 item");
    expect(plural(0, forms)).toBe("many items");
    expect(plural(2, forms)).toBe("many items");
  });

  it("uses the rules of the locale, with more forms", () => {
    // Polish: 2–4 are "few", 5 and more are "many".
    const plural = pluralFor("pl");
    const forms = { one: "one", few: "few", many: "many", other: "other" };
    expect(plural(1, forms)).toBe("one");
    expect(plural(3, forms)).toBe("few");
    expect(plural(5, forms)).toBe("many");
    expect(plural(1.5, forms)).toBe("other");
  });

  it("falls back to other for a form that is not given", () => {
    expect(pluralFor("pl")(3, { one: "one", other: "other" })).toBe("other");
  });
});

describe("the dictionary", () => {
  it("is English", () => {
    expect(locale).toBe("en");
  });

  it("puts values in the text", () => {
    expect(copy.lists.deleted("JojaMart")).toBe("Deleted the “JojaMart” list.");
    expect(copy.item.moved("Milk", "Oasis")).toBe(
      "Moved “Milk” to the “Oasis” list.",
    );
    expect(copy.item.editing(["Sam", "Alex"])).toBe("Sam, Alex is editing…");
    expect(copy.app.pageTitle("Settings")).toBe("Settings – Shopping Lists");
    expect(copy.consent.via("Sam")).toBe(
      "Its changes show as “Sam (via Claude)”. You can disconnect it at any time in Settings.",
    );
  });

  it("keeps the names as they are", () => {
    expect(copy.item.deleted("“Big” ${x} <b>")).toBe(
      "Deleted ““Big” ${x} <b>”.",
    );
  });

  it("uses plurals for counts", () => {
    expect(copy.lists.remaining(0)).toBe("0 items");
    expect(copy.lists.remaining(1)).toBe("1 item");
    expect(copy.lists.remaining(3)).toBe("3 items");
    expect(copy.lists.names(["Milk", "Eggs"])).toBe("Milk and Eggs");
    expect(copy.list.deletedChecked(1)).toBe("Deleted 1 item.");
    expect(copy.list.deletedChecked(3)).toBe("Deleted 3 items.");
    expect(copy.list.checkedAll(2)).toBe("Checked 2 items.");
    expect(copy.sync.changesToSync(1)).toBe("1 change to sync");
    expect(copy.sync.offlineWithChanges(2)).toBe("Offline · 2 changes to sync");
    expect(copy.settings.testSent(1)).toBe(
      "Sent a test notification to 1 device.",
    );
    expect(copy.settings.testSent(2)).toBe(
      "Sent a test notification to 2 devices.",
    );
    expect(copy.lists.deleteBody(0, ["Sam"])).toBe(
      "It’ll be deleted for Sam too.",
    );
    expect(copy.lists.deleteBody(1, ["Sam"])).toBe(
      "It has 1 item. It’ll be deleted for Sam too.",
    );
    expect(copy.lists.deleteBody(3, ["Sam", "Alex"])).toBe(
      "It has 3 items. They’ll be deleted for Sam and Alex too.",
    );
    expect(copy.lists.deleteBody(3, ["Sam", "Alex", "Jodi"])).toBe(
      "It has 3 items. They’ll be deleted for Sam, Alex, and Jodi too.",
    );
    expect(copy.lists.deleteBody(3, ["Sam", "Alex", "Jodi", "Kent"])).toBe(
      "It has 3 items. They’ll be deleted for everyone.",
    );
    expect(copy.lists.deleteBody(0, [])).toBe("It’ll be deleted.");
    expect(copy.push.burst("Sam", 2, 1, "JojaMart")).toBe(
      "Sam made 2 changes to the “JojaMart” list.",
    );
    expect(copy.push.burst("Sam", 5, 3, "JojaMart")).toBe(
      "Sam made 5 changes to 3 lists.",
    );
  });

  it("shows the last-used time of an app only when there is one", () => {
    expect(copy.settings.appUsage("app.example", "just now", null)).toBe(
      "app.example · Connected just now",
    );
    expect(
      copy.settings.appUsage("app.example", "3 days ago", "just now"),
    ).toBe("app.example · Connected 3 days ago · Last used just now");
  });
});

describe("the dictionary types", () => {
  it("make a missing key or a wrong value fail the typecheck", () => {
    // `npm run typecheck` fails if one of these lines has no type error.
    // @ts-expect-error: a missing key
    expect(copy.lists.missingKey).toBeUndefined();
    // @ts-expect-error: a value of the wrong type
    expect(copy.lists.deleted(3)).toBe("Deleted the “3” list.");
    // @ts-expect-error: a missing value
    expect(() => copy.addBar.duplicateBody(1)).not.toThrow();
  });
});
