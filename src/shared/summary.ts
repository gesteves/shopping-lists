// The list summary on the lists page. The client and the summary worker
// (src/server/summary/) use it.

/**
 * A list with fewer unchecked items shows their names, not a summary.
 * The worker makes no summary for it.
 */
export const SUMMARY_MIN_ITEMS = 2;

/** An item as the summary sees it. The notes are not in the summary. */
export interface SummaryItem {
  name: string;
  quantity: number;
}

/**
 * The same items, in any order, give the same key. The server keeps the key
 * of the items that a summary tells about (#91). The client makes the key
 * of its items: if the two are not the same, a new summary is on the way.
 */
export function summaryKey(items: SummaryItem[]): string {
  const parts = items.map((i) => JSON.stringify([i.name, i.quantity])).sort();
  return hash(parts.join("\n"));
}

/**
 * cyrb53: a fast 53-bit hash, the same on the server and in the browser.
 * It is not for security.
 */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
