"use client";

import { usePendingCount, useSyncStatus } from "@/client/hooks";

/** A short line about sync. #10 adds the full offline indicator. */
export function SyncStatus() {
  const { state } = useSyncStatus();
  const pending = usePendingCount() ?? 0;
  const changes = `${pending} ${pending === 1 ? "change" : "changes"}`;

  if (state === "unauthorized") {
    return (
      <a
        href="/sign-in"
        className="rounded-sm text-sm font-medium text-danger underline underline-offset-4"
      >
        {pending > 0
          ? `Sign in again to sync ${changes}`
          : "Sign in again to sync"}
      </a>
    );
  }
  const text =
    state === "offline"
      ? pending > 0
        ? `Offline · ${changes} to sync`
        : "Offline"
      : pending > 0
        ? `${changes} to sync`
        : null;
  if (!text) return null;
  return (
    <p className="text-sm text-ink-muted" role="status">
      {text}
    </p>
  );
}
