"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ListView } from "@/client/queries";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import { DeleteDialog, RenameForm } from "../../_components/list-index";
import { ConfirmDialog, useWaEvents } from "../../_components/wa";

/**
 * The list name, and a menu: rename, check all, uncheck all, delete the
 * checked items, and delete the list. Each bulk change has an undo (#67).
 */
export function ListHeader({ view }: { view: ListView }) {
  const { list, items } = view;
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const checked = items.filter((i) => i.checked).map((i) => i.id);
  const unchecked = items.filter((i) => !i.checked).map((i) => i.id);
  const remaining = unchecked.length;

  async function checkAll() {
    await mutate({ type: "checkAll", args: { listId: list.id } });
    showToast({
      message: copy.list.checkedAll(unchecked.length),
      action: {
        label: copy.common.undo,
        run: async () => {
          for (const itemId of unchecked) {
            await mutate({ type: "uncheck", args: { itemId } });
          }
        },
      },
    });
  }

  async function uncheckAll() {
    await mutate({ type: "uncheckAll", args: { listId: list.id } });
    showToast({
      message: copy.list.unchecked(checked.length),
      action: {
        label: copy.common.undo,
        run: async () => {
          for (const itemId of checked) {
            await mutate({ type: "check", args: { itemId } });
          }
        },
      },
    });
  }

  async function deleteChecked() {
    setClearing(false);
    await mutate({ type: "clearChecked", args: { listId: list.id } });
    showToast({
      message: copy.list.deletedChecked(checked.length),
      action: {
        label: copy.common.undo,
        run: async () => {
          for (const itemId of checked) {
            await mutate({ type: "restoreItem", args: { itemId } });
          }
        },
      },
    });
  }

  const menu = useWaEvents<HTMLElement>({
    "wa-select": (event) => {
      const value = (event as CustomEvent<{ item: { value: string } }>).detail
        .item.value;
      if (value === "rename") setRenaming(true);
      if (value === "check-all") void checkAll();
      if (value === "uncheck-all") void uncheckAll();
      if (value === "delete-checked") setClearing(true);
      if (value === "delete") setDeleting(true);
    },
  });

  if (renaming) {
    return (
      <div className="mt-2">
        <RenameForm list={list} onDone={() => setRenaming(false)} />
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-4xl font-bold tracking-tight text-balance break-words">
          {list.name}
        </h1>
        <wa-dropdown ref={menu} placement="bottom-end">
          <wa-button slot="trigger" appearance="plain" size="l">
            <wa-icon name="ellipsis" label={copy.list.actions}></wa-icon>
          </wa-button>
          <wa-dropdown-item value="rename">
            <wa-icon slot="icon" name="pen"></wa-icon>
            {copy.common.rename}
          </wa-dropdown-item>
          <wa-dropdown-item value="check-all" disabled={unchecked.length === 0}>
            <wa-icon slot="icon" name="square-check"></wa-icon>
            {copy.list.checkAll}
          </wa-dropdown-item>
          <wa-dropdown-item value="uncheck-all" disabled={checked.length === 0}>
            <wa-icon slot="icon" name="square"></wa-icon>
            {copy.list.uncheckAll}
          </wa-dropdown-item>
          <wa-dropdown-item
            value="delete-checked"
            disabled={checked.length === 0}
          >
            <wa-icon slot="icon" name="trash-can-check"></wa-icon>
            {copy.list.deleteChecked}
          </wa-dropdown-item>
          <wa-divider></wa-divider>
          <wa-dropdown-item value="delete" variant="danger">
            <wa-icon slot="icon" name="trash-can"></wa-icon>
            {copy.list.deleteList}
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
      <ConfirmDialog
        open={clearing}
        label={copy.list.deleteCheckedTitle(checked.length, list.name)}
        confirmLabel={copy.list.deleteCheckedConfirm}
        onConfirm={deleteChecked}
        onClose={() => setClearing(false)}
      >
        {copy.list.deleteCheckedBody}
      </ConfirmDialog>
      <DeleteDialog
        open={deleting}
        list={{ ...list, remaining }}
        onClose={() => setDeleting(false)}
        onDeleted={() => router.push("/")}
      />
    </div>
  );
}
