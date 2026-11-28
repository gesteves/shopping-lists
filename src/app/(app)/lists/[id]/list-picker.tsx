"use client";

import { useState } from "react";
import { copyPlan } from "@/client/copy-item";
import { getClientDb } from "@/client/db";
import { useLists } from "@/client/hooks";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import { useWaEvents } from "../../_components/wa";

export type PickMode = "move" | "copy";

export interface PickRequest {
  item: ItemRecord;
  mode: PickMode;
}

/**
 * The Move and Copy dialog (#131): one button for each other list. A tap
 * moves or copies the item at once, and a toast tells the result. Cancel,
 * Escape, and a tap outside close it.
 */
export function ListPicker({
  request,
  onClose,
}: {
  request: PickRequest | null;
  onClose: () => void;
}) {
  // Keep the last request while the dialog closes, so its content stays.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  const lists = useLists();
  const targets = lists?.filter((l) => l.id !== shown?.item.listId) ?? [];

  const ref = useWaEvents<HTMLElement>({
    "wa-after-hide": (event) => {
      if (event.target === event.currentTarget) onClose();
    },
  });

  async function pick(target: ListRecord) {
    if (!shown) return;
    const { item, mode } = shown;
    // Close before the write. Then the list view does not take the move
    // for a change from another device.
    onClose();
    if (mode === "move") await move(item, target);
    else await copyTo(item, target);
  }

  return (
    <wa-dialog
      ref={ref}
      open={request !== null}
      label={
        shown
          ? (shown.mode === "move" ? copy.item.moveTitle : copy.item.copyTitle)(
              shown.item.name,
            )
          : ""
      }
      light-dismiss
    >
      <ul aria-label={copy.item.targets} className="flex flex-col gap-2">
        {targets.map((list) => (
          <li key={list.id}>
            <button
              type="button"
              onClick={() => void pick(list)}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2 text-left font-medium wrap-anywhere"
            >
              <wa-icon
                name={shown?.mode === "copy" ? "copy" : "swap"}
                className="shrink-0 text-ink-muted"
              ></wa-icon>
              {list.name}
            </button>
          </li>
        ))}
      </ul>
      <wa-button slot="footer" appearance="plain" onClick={onClose}>
        {copy.common.cancel}
      </wa-button>
    </wa-dialog>
  );
}

async function move(item: ItemRecord, target: ListRecord) {
  await mutate({
    type: "moveItem",
    args: { itemId: item.id, toListId: target.id },
  });
  showToast({
    message: copy.item.moved(item.name, target.name),
    action: {
      label: copy.common.undo,
      run: () =>
        void mutate({
          type: "moveItem",
          args: { itemId: item.id, toListId: item.listId },
        }),
    },
  });
}

async function copyTo(item: ItemRecord, target: ListRecord) {
  const there = await getClientDb()
    .items.where("listId")
    .equals(target.id)
    .toArray();
  const plan = copyPlan(item, target.id, there);
  for (const request of plan.requests) await mutate(request);
  if (plan.kind === "add") {
    showToast({
      message: copy.item.copied(item.name, target.name),
      action: {
        label: copy.common.undo,
        run: () =>
          void mutate({ type: "deleteItem", args: { itemId: plan.itemId } }),
      },
    });
  } else {
    showToast({
      message: (plan.kind === "uncheck"
        ? copy.item.copyUnchecked
        : copy.item.copyOnList)(item.name, target.name),
    });
  }
}
