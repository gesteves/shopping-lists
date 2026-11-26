import { describe, expect, it } from "vitest";
import type { ItemRecord } from "@/shared/sync";
import {
  buildCandidates,
  rankSuggestions,
  score,
  type Candidate,
} from "./suggest";

const NOW = 1_764_000_000_000;
const DAY = 86_400_000;

function item(name: string, daysAgo: number): ItemRecord {
  const at = NOW - daysAgo * DAY;
  return {
    id: `${name}-${daysAgo}`,
    listId: "l",
    name,
    quantity: 1,
    notes: "",
    checked: false,
    checkedAt: null,
    createdBy: "u",
    createdAt: at,
    updatedBy: "u",
    updatedAt: at,
    updatedVia: "app",
    deletedAt: null,
    seq: 1,
  };
}

function c(key: string, count: number, daysAgo: number): Candidate {
  return { key, name: key, count, lastUsed: NOW - daysAgo * DAY };
}

describe("buildCandidates", () => {
  it("groups by name key, counts, and keeps the latest spelling", () => {
    const out = buildCandidates([
      item("milk", 10),
      item("Milk ", 2),
      item("Eggs", 1),
    ]);
    expect(out).toContainEqual({
      key: "milk",
      name: "Milk ",
      count: 2,
      lastUsed: NOW - 2 * DAY,
    });
    expect(out).toHaveLength(2);
  });
});

describe("score", () => {
  it("rises with the count and with recency", () => {
    expect(score(c("a", 5, 1), NOW)).toBeGreaterThan(score(c("a", 1, 1), NOW));
    expect(score(c("a", 1, 1), NOW)).toBeGreaterThan(score(c("a", 1, 60), NOW));
  });

  it("lets a recent name beat an old one that was used a few more times", () => {
    expect(score(c("a", 2, 0), NOW)).toBeGreaterThan(score(c("a", 4, 90), NOW));
  });
});

describe("rankSuggestions", () => {
  const all = [
    c("oat milk", 3, 2),
    c("milk", 10, 30),
    c("buttermilk", 9, 1),
    c("almond milk", 1, 1),
    c("mild salsa", 1, 200),
    c("eggs", 20, 0),
  ];

  it("puts prefix matches first, then word starts, then the middle", () => {
    expect(rankSuggestions("mil", all, { now: NOW }).map((x) => x.key)).toEqual(
      ["milk", "mild salsa", "oat milk", "almond milk", "buttermilk"],
    );
  });

  it("ranks by score in one tier", () => {
    const keys = rankSuggestions("m", all, { now: NOW }).map((x) => x.key);
    expect(keys.slice(0, 2)).toEqual(["milk", "mild salsa"]);
  });

  it("normalizes the query and leaves out an exact match and excluded names", () => {
    expect(
      rankSuggestions("  MILK ", all, {
        now: NOW,
        exclude: new Set(["oat milk"]),
      }).map((x) => x.key),
    ).toEqual(["almond milk", "buttermilk"]);
  });

  it("gives nothing for an empty query, and respects the limit", () => {
    expect(rankSuggestions("  ", all)).toEqual([]);
    expect(rankSuggestions("l", all, { now: NOW, limit: 2 })).toHaveLength(2);
  });
});
