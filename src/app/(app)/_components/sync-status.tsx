"use client";

import { usePendingCount, useSyncStatus } from "@/client/hooks";
import { copy } from "@/copy";

/** A short line about sync. #10 adds the full offline indicator. */
export function SyncStatus() {
  const { state } = useSyncStatus();
  const pending = usePendingCount() ?? 0;

  if (state === "unauthorized") {
    return (
      <a
        href="/sign-in"
        className="rounded-sm text-sm font-medium text-danger underline underline-offset-4"
      >
        {pending > 0
          ? copy.sync.signInAgainWithChanges(pending)
          : copy.sync.signInAgain}
      </a>
    );
  }
  const text =
    state === "offline"
      ? pending > 0
        ? copy.sync.offlineWithChanges(pending)
        : copy.sync.offline
      : pending > 0
        ? copy.sync.changesToSync(pending)
        : null;
  if (!text) return null;
  return (
    <p className="text-sm text-ink-muted" role="status">
      {text}
    </p>
  );
}
