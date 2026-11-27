"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useMergedOps, useRejectedOps } from "@/client/hooks";
import { recreateFor } from "@/client/recreate";
import type { MergedDetail, RejectedDetail } from "@/client/sync";
import { copy } from "@/copy";
import {
  dismissToast,
  showToast,
  toastStore,
  type Toast,
} from "@/client/toasts";

interface WaToast extends HTMLElement {
  create(
    message: string,
    options?: { duration?: number; variant?: string; icon?: string },
  ): Promise<HTMLElement & { hide(): Promise<void> }>;
}

/**
 * The toasts (src/client/toasts.ts) in a <wa-toast>. Each item closes
 * itself after its duration; the store keeps the limit (3). Also a toast
 * for each change that the server refused, and for each add that it
 * merged.
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

  const router = useRouter();

  useRejectedOps(
    useCallback(
      async ({ op, reason }: RejectedDetail) => {
        const recreate =
          reason === "list_deleted" ? await recreateFor(op) : null;
        if (recreate) {
          showToast({
            message: (recreate.kind === "add"
              ? copy.toasts.listDeletedAdd
              : copy.toasts.listDeletedMove)(
              recreate.listName,
              recreate.itemName,
            ),
            duration: 10_000,
            action: {
              label: copy.toasts.recreate,
              run: async () => {
                const listId = await recreate.run();
                // On the page of the deleted list: open the new list.
                // The path at the tap: usePathname() needs a Suspense
                // boundary, and the toaster is outside of one.
                if (location.pathname === `/lists/${recreate.listId}`) {
                  router.push(`/lists/${listId}`);
                }
              },
            },
          });
          return;
        }
        // An unknown reason (a newer server) gets a general text.
        const text = (copy.toasts.reasons as Record<string, string>)[reason];
        showToast({
          message: text
            ? copy.toasts.rejected(text)
            : copy.toasts.rejectedGeneral,
        });
      },
      [router],
    ),
  );
  useMergedOps(
    useCallback(({ op, changed }: MergedDetail) => {
      if (op.type !== "addItem") return;
      showToast({
        message: changed
          ? copy.toasts.mergedUnchecked(op.args.name)
          : copy.toasts.merged(op.args.name),
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
  // Text only (no allowHtml): list and item names come from users.
  // create() spreads the options over its defaults: leave out each unset one.
  const item = await el.create(toast.message, {
    ...(toast.duration !== undefined && { duration: toast.duration }),
    ...(toast.variant && { variant: toast.variant }),
    ...(toast.icon && { icon: toast.icon }),
  });
  item.addEventListener("wa-after-hide", () => dismissToast(toast.id));
  if (toast.action) {
    // The action goes on its own line, below the message.
    const actions = document.createElement("div");
    actions.style.marginBlockStart = "var(--wa-space-xs)";
    const button = document.createElement("wa-button");
    button.setAttribute("size", "s");
    button.setAttribute("variant", "brand");
    button.textContent = toast.action.label;
    const { run } = toast.action;
    button.addEventListener("click", () => {
      dismissToast(toast.id);
      void run();
    });
    actions.append(button);
    item.append(actions);
  }
  return item;
}
