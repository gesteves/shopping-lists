"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useRejectedOps } from "@/client/hooks";
import type { RejectedDetail } from "@/client/sync";
import { dismissToast, showToast, toastStore } from "@/client/toasts";

const REJECTED: Record<RejectedDetail["reason"], string> = {
  list_deleted: "the list was deleted",
  list_not_found: "the list doesn’t exist anymore",
  list_exists: "that list already exists",
  item_not_found: "the item doesn’t exist anymore",
  item_exists: "that item already exists",
  clock_ahead: "this device’s clock is wrong",
  invalid: "the change wasn’t valid",
};

/** The toasts, and a toast for each change that the server refused. */
export function Toaster() {
  const toasts = useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    toastStore.getServerSnapshot,
  );

  useRejectedOps(
    useCallback(({ reason }: RejectedDetail) => {
      showToast({ message: `A change didn’t save: ${REJECTED[reason]}.` });
    }, []),
  );

  return (
    <div
      role="status"
      aria-live="polite"
      // Above the add bar of a list.
      className="pointer-events-none fixed inset-x-4 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] z-40 mx-auto flex max-w-md flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-ink py-2 pr-2 pl-4 text-canvas shadow-lg"
        >
          <p className="flex-1 py-1">{toast.message}</p>
          {toast.action && (
            <button
              type="button"
              onClick={async () => {
                dismissToast(toast.id);
                await toast.action?.run();
              }}
              className="min-h-11 rounded-lg px-3 font-semibold text-canvas underline underline-offset-4"
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
            className="grid size-11 place-items-center rounded-lg text-canvas/80"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
