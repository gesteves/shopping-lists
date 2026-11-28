"use client";

import { useCallback, useState } from "react";
import { copyPlan } from "@/client/copy-item";
import { getClientDb } from "@/client/db";
import { useLists } from "@/client/hooks";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import { PrivateIcon } from "../../_components/list-index";
import { useWaEvents } from "../../_components/wa";

export type PickMode = "move" | "copy";

export interface PickRequest {
  item: ItemRecord;
  mode: PickMode;
}

/**
 * The Move and Copy dialog (#131): a select of the other lists, and a Move
 * or Copy button (#134). The select keeps the dialog short when there are
 * many lists. The button is disabled until the user selects a list. A toast
 * tells the result. Cancel, Escape, and a tap outside close it.
 *
 * Move shows only the lists of the same kind (#154): a move never takes an
 * item between a private list and a shared list. Copy shows all lists.
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
  // The ID of the selected list. Each new request starts with none.
  const [targetId, setTargetId] = useState("");
  if (request && request !== shown) {
    setShown(request);
    setTargetId("");
  }
  const lists = useLists();
  const mode = shown?.mode ?? "move";
  const targets = pickTargets(lists ?? [], shown?.item.listId, mode);
  const target = targets.find((l) => l.id === targetId);

  const ref = useWaEvents<HTMLElement>({
    // Only this dialog: the events of the select in it bubble too.
    "wa-after-hide": (event) => {
      if (event.target === event.currentTarget) onClose();
    },
  });
  const selectEvents = useWaEvents<HTMLElement>({
    change: (event) =>
      setTargetId((event.currentTarget as HTMLSelectElement).value),
  });
  // The dialog focuses the element with "autofocus" when it opens. The JSX
  // types of wa-select do not have it, thus set it here. The display field
  // of the select is read-only: the on-screen keyboard does not open.
  const selectRef = useCallback(
    (el: HTMLElement | null) => {
      el?.setAttribute("autofocus", "");
      return selectEvents(el);
    },
    [selectEvents],
  );

  async function confirm() {
    if (!shown || !target) return;
    const { item } = shown;
    // Close before the write. Then the list view does not take the move
    // for a change from another device.
    onClose();
    if (mode === "move") await move(item, target);
    else await copyTo(item, target);
  }

  return (
    <wa-dialog
      suppressHydrationWarning
      ref={ref}
      open={request !== null}
      label={
        shown
          ? (mode === "move" ? copy.item.moveTitle : copy.item.copyTitle)(
              shown.item.name,
            )
          : ""
      }
      light-dismiss
    >
      <wa-select
        suppressHydrationWarning
        ref={selectRef}
        label={copy.item.targets}
        placeholder={copy.item.pickList}
        value={targetId}
      >
        {targets.map((list) => (
          <wa-option suppressHydrationWarning key={list.id} value={list.id}>
            {list.name}
            {list.private === true && (
              <span slot="end">
                <PrivateIcon />
              </span>
            )}
          </wa-option>
        ))}
      </wa-select>
      <wa-button
        suppressHydrationWarning
        slot="footer"
        appearance="plain"
        onClick={onClose}
      >
        {copy.common.cancel}
      </wa-button>
      <wa-button
        suppressHydrationWarning
        slot="footer"
        variant="brand"
        disabled={!target}
        onClick={() => void confirm()}
      >
        <wa-icon
          suppressHydrationWarning
          slot="start"
          name={mode === "copy" ? "copy" : "swap"}
        ></wa-icon>
        {mode === "move" ? copy.item.move : copy.item.copy}
      </wa-button>
    </wa-dialog>
  );
}

/**
 * The lists that an item on `fromId` can go to: all the other lists for a
 * copy, and the other lists of the same kind for a move (#154).
 */
export function pickTargets(
  lists: ListRecord[],
  fromId: string | undefined,
  mode: PickMode,
): ListRecord[] {
  const from = lists.find((l) => l.id === fromId);
  return lists.filter(
    (l) =>
      l.id !== fromId &&
      (mode === "copy" || (l.private === true) === (from?.private === true)),
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
