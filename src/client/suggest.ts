// Autocomplete for the add bar (#14). Suggestions come from every item that
// this device knows, on every list, deleted items included.
import { nameKey } from "@/shared/names";
import type { ItemRecord } from "@/shared/sync";

export interface Candidate {
  key: string;
  /** The name as it was typed the last time. */
  name: string;
  /** How many items had this name. */
  count: number;
  /** The last time someone added or changed an item with this name. */
  lastUsed: number;
}

/** Group the items by name key. */
export function buildCandidates(items: Iterable<ItemRecord>): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const item of items) {
    const key = nameKey(item.name);
    const used = Math.max(item.createdAt, item.updatedAt);
    const found = byKey.get(key);
    if (!found) {
      byKey.set(key, { key, name: item.name, count: 1, lastUsed: used });
      continue;
    }
    found.count++;
    if (used > found.lastUsed) {
      found.lastUsed = used;
      found.name = item.name;
    }
  }
  return [...byKey.values()];
}

const DAY = 24 * 60 * 60 * 1000;
/** A use loses half its recency weight every 14 days. */
const HALF_LIFE_DAYS = 14;

/**
 * The score of a candidate: how often (log, so a very common name does not
 * hide all others) plus how recently.
 */
export function score(c: Candidate, now: number): number {
  const ageDays = Math.max(0, now - c.lastUsed) / DAY;
  return Math.log2(1 + c.count) + 2 * 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

/**
 * The best suggestions for `query`. A match at the start of the name, or at
 * the start of a word, comes before a match in the middle. Names in
 * `exclude` (keys) are left out, for example the unchecked items of the
 * current list.
 */
export function rankSuggestions(
  query: string,
  candidates: Candidate[],
  options: { now?: number; limit?: number; exclude?: Set<string> } = {},
): Candidate[] {
  const q = nameKey(query);
  if (!q) return [];
  const now = options.now ?? Date.now();
  const ranked: { c: Candidate; tier: number; s: number }[] = [];
  for (const c of candidates) {
    if (c.key === q || options.exclude?.has(c.key)) continue;
    const at = c.key.indexOf(q);
    if (at < 0) continue;
    const tier = at === 0 ? 0 : c.key[at - 1] === " " ? 1 : 2;
    ranked.push({ c, tier, s: score(c, now) });
  }
  ranked.sort(
    (a, b) => a.tier - b.tier || b.s - a.s || a.c.key.localeCompare(b.c.key),
  );
  return ranked.slice(0, options.limit ?? 6).map((r) => r.c);
}
