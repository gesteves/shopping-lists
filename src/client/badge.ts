// The app icon badge (#161). The service worker counts the pushes that the
// user did not see (src/sw/sw.ts). The app clears the count when a page
// shows: at the load, and each time the app comes to the front.
import { clearBadge } from "@/shared/badge";

/** Remove the badge and set the count to 0. It never rejects. */
export async function clearAppBadge(): Promise<void> {
  try {
    await clearBadge(
      typeof caches === "undefined" ? undefined : caches,
      navigator,
    );
  } catch {
    // The badge stays until the next time. This is not a bug to report.
  }
}
