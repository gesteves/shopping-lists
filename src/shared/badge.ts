// The app icon badge (#161): the number of pushes that came since the user
// last saw the app on this device. The service worker adds 1 for each push,
// and the app clears it when a page shows. See "Notifications" in
// docs/PLAN.md. The worker and the page both use this file, thus it uses
// no DOM or worker globals: the caller gives them.

/**
 * The cache that keeps the count. The worker can stop between two pushes,
 * thus the count cannot stay in memory. The sign-out deletes this cache
 * with the other runtime caches. A new version does not delete it.
 */
export const BADGE_CACHE = "badge";
const COUNT_KEY = "/badge-count";

/** The part of the Navigator object that the badge uses. */
export interface BadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** True if the browser can show a badge. */
export function badgeSupported(nav: BadgeNavigator): boolean {
  return (
    typeof nav.setAppBadge === "function" &&
    typeof nav.clearAppBadge === "function"
  );
}

/** The count now. 0 if there is no count or it is not valid. */
export async function readBadgeCount(storage: CacheStorage): Promise<number> {
  const cache = await storage.open(BADGE_CACHE);
  const response = await cache.match(COUNT_KEY);
  if (!response) return 0;
  const count = Number(await response.text());
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Add 1 to the count and show it. The worker calls this for each push.
 * It does nothing where the browser shows no badge. A refused badge (for
 * example, no notification permission) is not an error.
 */
export async function addToBadge(
  storage: CacheStorage,
  nav: BadgeNavigator,
): Promise<void> {
  if (!badgeSupported(nav)) return;
  const count = (await readBadgeCount(storage)) + 1;
  const cache = await storage.open(BADGE_CACHE);
  await cache.put(COUNT_KEY, new Response(String(count)));
  await nav.setAppBadge!(count).catch(() => {});
}

/** Set the count to 0 and remove the badge. The app calls this. */
export async function clearBadge(
  storage: CacheStorage | undefined,
  nav: BadgeNavigator,
): Promise<void> {
  if (!badgeSupported(nav)) return;
  await nav.clearAppBadge!().catch(() => {});
  await storage?.delete(BADGE_CACHE);
}
