// The list summary on the lists page. The client and the summary worker
// (src/server/summary/) use it.

/**
 * A list with fewer unchecked items shows their names, not a summary.
 * The worker makes no summary for it.
 */
export const SUMMARY_MIN_ITEMS = 2;
