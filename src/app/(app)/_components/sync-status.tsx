"use client";

import { useEffect, useState } from "react";
import { usePendingCount, useSyncStatus } from "@/client/hooks";
import { syncIndicator } from "@/client/sync-indicator";

/** A normal online state shows only when it stays this long. */
const SHOW_AFTER_MS = 2000;

/**
 * The sync state in the header: a cloud icon. The text is for a screen reader,
 * and shows on hover. The `role="status"` element stays in the DOM, so that a
 * screen reader reads each change.
 */
export function SyncStatus() {
  const { state } = useSyncStatus();
  const pending = usePendingCount() ?? 0;
  const indicator = syncIndicator(state, pending);
  const waited = useDelayedTrue(indicator?.delayed === true, SHOW_AFTER_MS);
  const shown = indicator && (!indicator.delayed || waited) ? indicator : null;

  let content: React.ReactNode = null;
  if (shown) {
    const tone = shown.tone === "danger" ? "text-danger" : "text-ink-muted";
    const inner = (
      <>
        <wa-icon
          name={shown.icon}
          animation={shown.animate ? "fade" : undefined}
          aria-hidden="true"
          title={shown.text ?? undefined}
          style={{ "--fade-opacity": "0.4" }}
        ></wa-icon>
        {shown.text && <span className="sr-only">{shown.text}</span>}
      </>
    );
    content = shown.href ? (
      <a
        href={shown.href}
        className={`flex min-h-11 min-w-11 items-center justify-center rounded-sm ${tone}`}
      >
        {inner}
      </a>
    ) : (
      <span className={`flex items-center ${tone}`}>{inner}</span>
    );
  }
  return (
    <p className="flex items-center text-sm empty:sr-only" role="status">
      {content}
    </p>
  );
}

/** True when `value` has been true for `ms`. False at once when it is not. */
function useDelayedTrue(value: boolean, ms: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => setDone(true), ms);
    return () => {
      clearTimeout(timer);
      setDone(false);
    };
  }, [value, ms]);
  return value && done;
}
