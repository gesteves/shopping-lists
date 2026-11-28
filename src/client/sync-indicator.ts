import { copy } from "@/copy";
import type { SyncState } from "./sync/engine";

/** What the header shows for sync: an icon, and text for a screen reader. */
export interface SyncIndicator {
  icon: "cloud-arrow-up" | "cloud-slash" | "cloud-exclamation";
  tone: "muted" | "danger";
  /** True while a sync runs: the icon fades in and out. */
  animate: boolean;
  /** The status text. Null when a sync runs with no changes to send. */
  text: string | null;
  /** The icon and text are a link to this page. */
  href?: string;
  /**
   * True for a normal online state. The header shows it only when it stays
   * for some seconds, thus a fast sync after each save does not flash.
   */
  delayed: boolean;
}

/** The indicator for a sync state and a count of changes to sync. */
export function syncIndicator(
  state: SyncState,
  pending: number,
): SyncIndicator | null {
  switch (state) {
    case "unauthorized":
      return {
        icon: "cloud-exclamation",
        tone: "danger",
        animate: false,
        text:
          pending > 0
            ? copy.sync.signInAgainWithChanges(pending)
            : copy.sync.signInAgain,
        href: "/sign-in",
        delayed: false,
      };
    case "error":
      return {
        icon: "cloud-exclamation",
        tone: "danger",
        animate: false,
        text:
          pending > 0 ? copy.sync.errorWithChanges(pending) : copy.sync.error,
        delayed: false,
      };
    case "offline":
      return {
        icon: "cloud-slash",
        tone: "muted",
        animate: false,
        text:
          pending > 0
            ? copy.sync.offlineWithChanges(pending)
            : copy.sync.offline,
        delayed: false,
      };
    case "idle":
    case "syncing":
      if (state === "idle" && pending === 0) return null;
      return {
        icon: "cloud-arrow-up",
        tone: "muted",
        animate: state === "syncing",
        text: pending > 0 ? copy.sync.changesToSync(pending) : null,
        delayed: true,
      };
  }
}
