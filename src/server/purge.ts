// The daily purge of old tombstones (#20). See "Sync design" in
// docs/PLAN.md: a client with an older cursor gets all rows again.
import "server-only";
import { purgeTombstones, type PurgeResult } from "./ops";

/** Delete tombstones and old bookkeeping rows after this many days. */
export const PURGE_AFTER_DAYS = 30;
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The first purge after boot. Not at once: the boot must stay fast. */
export const FIRST_PURGE_MS = 5 * 60 * 1000;

/** Runs one purge. Logs the result, and never throws. */
export function runPurge(
  purge: (days: number) => PurgeResult = purgeTombstones,
): PurgeResult | null {
  try {
    const result = purge(PURGE_AFTER_DAYS);
    console.log("Purged tombstones:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Purge failed:", error);
    return null;
  }
}

/** Starts the schedule one time for the process. */
export function startPurger(purge?: (days: number) => PurgeResult): void {
  const KEY = Symbol.for("shopping-lists.purger");
  const store = globalThis as typeof globalThis & { [KEY]?: true };
  if (store[KEY]) return;
  store[KEY] = true;
  setTimeout(() => {
    runPurge(purge);
    setInterval(() => runPurge(purge), PURGE_EVERY_MS).unref();
  }, FIRST_PURGE_MS).unref();
}
