// The list summary on the lists page. The client and the summary worker
// (src/server/summary/) use it.

/**
 * A list with fewer unchecked items shows their names, not a summary.
 * The worker makes no summary for it.
 */
export const SUMMARY_MIN_ITEMS = 2;

/**
 * The longest time from a change of the items to the new summary, with a
 * margin: the longest wait of the worker (3 minutes), one tick (10 s), and
 * the Claude request (10 s, 1 retry). Until then, the lists page shows a
 * skeleton in place of a summary that is not for the current items (#143).
 * After it, the page shows the count: the request failed.
 */
export const SUMMARY_WAIT_MS = 4 * 60_000;

/** An unchecked item, as the summary sees it. */
export interface SummaryItem {
  name: string;
  quantity: number;
}

/**
 * The text that the summary key is a hash of. The same items, in any order,
 * give the same text. The notes and the URL are not in the summary, thus
 * not in the text.
 */
export function summaryKeyText(items: readonly SummaryItem[]): string {
  return items
    .map((i) => JSON.stringify([i.name, i.quantity]))
    .sort()
    .join("\n");
}

/**
 * The summary key: SHA-256 of summaryKeyText, in base64url with no padding.
 * The server makes the same key with node:crypto (summaryKey in
 * src/server/summary/worker.ts). The client compares it with the key of
 * the stored summary (#143).
 */
export async function summaryKeyOf(
  items: readonly SummaryItem[],
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(summaryKeyText(items)),
    ),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
