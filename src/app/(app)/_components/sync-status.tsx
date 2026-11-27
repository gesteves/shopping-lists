"use client";

import { usePendingCount, useSyncStatus } from "@/client/hooks";
import { copy } from "@/copy";

/**
 * A short line about sync. The `role="status"` element stays in the DOM, so
 * that a screen reader reads each change.
 */
export function SyncStatus() {
  const { state } = useSyncStatus();
  const pending = usePendingCount() ?? 0;

  let content: React.ReactNode = null;
  if (state === "unauthorized") {
    content = (
      <a
        href="/sign-in"
        className="rounded-sm font-medium text-danger underline underline-offset-4"
      >
        {pending > 0
          ? copy.sync.signInAgainWithChanges(pending)
          : copy.sync.signInAgain}
      </a>
    );
  } else if (state === "error") {
    content = (
      <span className="text-danger">
        {pending > 0 ? copy.sync.errorWithChanges(pending) : copy.sync.error}
      </span>
    );
  } else if (state === "offline") {
    content =
      pending > 0 ? copy.sync.offlineWithChanges(pending) : copy.sync.offline;
  } else if (pending > 0) {
    content = copy.sync.changesToSync(pending);
  }
  return (
    <p className="text-sm text-ink-muted empty:sr-only" role="status">
      {content}
    </p>
  );
}
