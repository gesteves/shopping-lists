import { describe, expect, it } from "vitest";
import { QUANTITY_MAX } from "./ops";
import { clampQuantity } from "./quantity";

describe("clampQuantity", () => {
  it("keeps a good quantity", () => {
    expect(clampQuantity("3", 1)).toBe(3);
    expect(clampQuantity(" 12 ", 1)).toBe(12);
  });

  it("clamps to 1 and to the maximum", () => {
    expect(clampQuantity("0", 4)).toBe(1);
    expect(clampQuantity("-5", 4)).toBe(1);
    expect(clampQuantity("1000", 4)).toBe(QUANTITY_MAX);
    expect(clampQuantity("2.7", 4)).toBe(2);
  });

  it("gives the fallback for an empty field or text", () => {
    expect(clampQuantity("", 4)).toBe(4);
    expect(clampQuantity("  ", 4)).toBe(4);
    expect(clampQuantity("abc", 4)).toBe(4);
  });
});
