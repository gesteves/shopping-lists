"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useMergedOps, useRejectedOps } from "@/client/hooks";
import type { MergedDetail, RejectedDetail } from "@/client/sync";
import {
  dismissToast,
  showToast,
  toastStore,
  type Toast,
} from "@/client/toasts";

const REJECTED: Record<RejectedDetail["reason"], string> = {
  list_deleted: "the list was deleted",
  list_not_found: "the list doesn’t exist anymore",
  list_exists: "that list already exists",
  item_not_found: "the item doesn’t exist anymore",
  item_exists: "that item already exists",
  clock_ahead: "this device’s clock is wrong",
  invalid: "the change wasn’t valid",
};

interface WaToast extends HTMLElement {
  create(
    message: string,
    options?: { duration?: number; variant?: string },
  ): Promise<HTMLElement & { hide(): Promise<void> }>;
}

/**
 * The toasts (src/client/toasts.ts) in a <wa-toast>. The store keeps the
 * time (5 s) and the limit (3). Also a toast for each change that the
 * server refused, and for each add that it merged.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    toastStore.getServerSnapshot,
  );
  const host = useRef<WaToast>(null);
  const shown = useRef(new Map<number, Promise<{ hide(): Promise<void> }>>());

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ids = new Set(toasts.map((t) => t.id));
    for (const toast of toasts) {
      if (!shown.current.has(toast.id)) {
        shown.current.set(toast.id, show(el, toast));
      }
    }
    for (const [id, item] of shown.current) {
      if (ids.has(id)) continue;
      shown.current.delete(id);
      void item.then((i) => i.hide()).catch(() => undefined);
    }
  }, [toasts]);

  useRejectedOps(
    useCallback(({ reason }: RejectedDetail) => {
      showToast({ message: `A change didn’t save: ${REJECTED[reason]}.` });
    }, []),
  );
  useMergedOps(
    useCallback(({ op, changed }: MergedDetail) => {
      if (op.type !== "addItem") return;
      showToast({
        message: changed
          ? `“${op.args.name}” was already on the list. It’s unchecked now.`
          : `“${op.args.name}” was already on the list.`,
      });
    }, []),
  );

  // Above the add bar of a list.
  return (
    <wa-toast
      ref={host as never}
      placement="bottom-center"
      className="mb-[calc(env(safe-area-inset-bottom)+4.5rem)]"
    ></wa-toast>
  );
}

async function show(el: WaToast, toast: Toast) {
  await customElements.whenDefined("wa-toast");
  // The store closes the toast: no time limit here.
  const item = await el.create(toast.message, { duration: 0 });
  item.addEventListener("wa-after-hide", () => dismissToast(toast.id));
  if (toast.action) {
    const button = document.createElement("wa-button");
    button.setAttribute("size", "s");
    button.setAttribute("appearance", "plain");
    button.setAttribute("variant", "brand");
    button.className = "ml-2";
    button.textContent = toast.action.label;
    const { run } = toast.action;
    button.addEventListener("click", () => {
      dismissToast(toast.id);
      void run();
    });
    item.append(button);
  }
  return item;
}
