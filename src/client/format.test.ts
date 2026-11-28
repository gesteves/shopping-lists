import { describe, expect, it } from "vitest";
import type { ItemRecord, UserRecord } from "@/shared/sync";
import { initials, itemHistory, relativeTime } from "./format";

describe("initials", () => {
  it("gives the first grapheme in capitals", () => {
    expect(initials("emily")).toBe("E");
    expect(initials(" Émile")).toBe("É");
    // A flag and a family emoji have more than one code point.
    expect(initials("🇦🇷 Guille")).toBe("🇦🇷");
    expect(initials("👨‍👩‍👧 Home")).toBe("👨‍👩‍👧");
    // "e" and a combining accent are one grapheme.
    expect(initials("e\u0301lise")).toBe("E\u0301");
    expect(initials("")).toBe("");
  });
});

const NOW = Date.UTC(2026, 10, 26, 18, 0, 0);
const MIN = 60_000;

describe("relativeTime", () => {
  it("gives short relative times", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe("5 min. ago");
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe("3 hr. ago");
    expect(relativeTime(NOW - 26 * 60 * MIN, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("3 days ago");
  });

  it("gives a date after a week", () => {
    expect(relativeTime(Date.UTC(2026, 9, 1, 12), NOW)).toBe("Oct 1");
    expect(relativeTime(Date.UTC(2025, 9, 1, 12), NOW)).toBe("Oct 1, 2025");
  });
});

describe("itemHistory", () => {
  const users = new Map<string, UserRecord>([
    ["s", { id: "s", name: "Sam", image: null }],
    ["a", { id: "a", name: "Alex", image: null }],
  ]);
  const item = {
    createdBy: "s",
    createdAt: NOW - 5 * MIN,
    updatedBy: "s",
    updatedAt: NOW - 5 * MIN,
    updatedVia: "app",
  } as ItemRecord;

  it("gives only the add when there is no later change", () => {
    expect(itemHistory(item, users, NOW)).toEqual([
      "Added by Sam · 5 min. ago",
    ]);
  });

  it("names the person and Claude for a later change", () => {
    expect(
      itemHistory(
        { ...item, updatedBy: "a", updatedAt: NOW - 1000, updatedVia: "mcp" },
        users,
        NOW,
      ),
    ).toEqual([
      "Added by Sam · 5 min. ago",
      "Updated by Alex (via Claude) · just now",
    ]);
  });

  it("says Someone for a user that is not known", () => {
    expect(itemHistory({ ...item, createdBy: "x" }, users, NOW)[0]).toMatch(
      /^Added by Someone/,
    );
  });
});
