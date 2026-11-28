import { describe, expect, it } from "vitest";
import { checkedFields } from "./duplicate";

const item = { quantity: 2, notes: "Oat", url: "" };

describe("checkedFields", () => {
  it("is undefined for the defaults", () => {
    expect(checkedFields(item, { quantity: 1, notes: "" })).toBeUndefined();
    expect(checkedFields(item, { quantity: 1, notes: "  " })).toBeUndefined();
  });

  it("is undefined when the fields are the same as the item", () => {
    expect(
      checkedFields(item, { quantity: 2, notes: " Oat " }),
    ).toBeUndefined();
  });

  it("gives the quantity and the notes that the user typed", () => {
    expect(checkedFields(item, { quantity: 3, notes: "" })).toEqual({
      quantity: 3,
    });
    expect(checkedFields(item, { quantity: 1, notes: " Soy " })).toEqual({
      notes: "Soy",
    });
    expect(checkedFields(item, { quantity: 3, notes: "Soy" })).toEqual({
      quantity: 3,
      notes: "Soy",
    });
  });

  it("gives a URL that is not empty and not the same (#140)", () => {
    const url = "https://example.com/soy";
    expect(checkedFields(item, { quantity: 1, notes: "", url })).toEqual({
      url,
    });
    expect(
      checkedFields(item, { quantity: 1, notes: "", url: "  " }),
    ).toBeUndefined();
    expect(
      checkedFields({ ...item, url }, { quantity: 1, notes: "", url }),
    ).toBeUndefined();
  });
});
