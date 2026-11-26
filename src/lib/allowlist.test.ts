import { describe, expect, it } from "vitest";
import { isAllowedEmail, parseAllowlist } from "./allowlist";

describe("allowlist", () => {
  it("trims, lowercases, and drops empty entries", () => {
    expect([...parseAllowlist(" A@Example.com, ,b@example.com,")]).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("compares emails without case", () => {
    expect(isAllowedEmail("A@EXAMPLE.COM", "a@example.com")).toBe(true);
    expect(isAllowedEmail("c@example.com", "a@example.com")).toBe(false);
  });

  it("allows no one when the list is empty or missing", () => {
    expect(isAllowedEmail("a@example.com", "")).toBe(false);
    expect(isAllowedEmail("a@example.com", undefined)).toBe(false);
    expect(isAllowedEmail("", "a@example.com")).toBe(false);
    expect(isAllowedEmail(null, "a@example.com")).toBe(false);
  });
});
