import { describe, expect, it } from "vitest";
import { nameKey } from "./names";

describe("nameKey", () => {
  it("makes lowercase, trims, and collapses white space", () => {
    expect(nameKey("  Oat   Milk ")).toBe("oat milk");
    expect(nameKey("OAT\tmilk\n")).toBe("oat milk");
    expect(nameKey("oat milk")).toBe("oat milk");
  });

  it("gives one key for the composed and decomposed forms", () => {
    expect(nameKey("Café")).toBe(nameKey("Café"));
  });

  it("keeps other characters", () => {
    expect(nameKey("2% Milk (1 gal)")).toBe("2% milk (1 gal)");
  });
});
