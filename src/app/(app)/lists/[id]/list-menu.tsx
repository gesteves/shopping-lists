"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ListView } from "@/client/queries";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { DeleteDialog, RenameForm } from "../../_components/list-index";
import { ConfirmDialog, useWaEvents } from "../../_components/wa";

function count(n: number) {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/**
 * The list name, and a menu: rename, uncheck all, clear checked items, and
 * delete the list.
 */
export function ListHeader({ view }: { view: ListView }) {
  const { list, items } = view;
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const checked = items.filter((i) => i.checked).map((i) => i.id);
  const remaining = items.length - checked.length;

  async function uncheckAll() {
    await mutate({ type: "uncheckAll", args: { listId: list.id } });
    showToast({
      message: `Unchecked ${count(checked.length)}.`,
      action: {
        label: "Undo",
        run: async () => {
          for (const itemId of checked) {
            await mutate({ type: "check", args: { itemId } });
          }
        },
      },
    });
  }

  async function clearChecked() {
    setClearing(false);
    await mutate({ type: "clearChecked", args: { listId: list.id } });
    showToast({
      message: `Cleared ${count(checked.length)}.`,
      action: {
        label: "Undo",
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
      if (value === "uncheck-all") void uncheckAll();
      if (value === "clear-checked") setClearing(true);
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
        <h1 className="flex-1 text-4xl font-bold tracking-tight text-balance break-words">
          {list.name}
        </h1>
        <wa-dropdown ref={menu} placement="bottom-end">
          <wa-button slot="trigger" appearance="plain" size="l">
            <wa-icon name="ellipsis" label="List actions"></wa-icon>
          </wa-button>
          <wa-dropdown-item value="rename">
            <wa-icon slot="icon" name="pen"></wa-icon>
            Rename
          </wa-dropdown-item>
          <wa-dropdown-item value="uncheck-all" disabled={checked.length === 0}>
            <wa-icon slot="icon" name="rotate-left"></wa-icon>
            Uncheck all
          </wa-dropdown-item>
          <wa-dropdown-item
            value="clear-checked"
            disabled={checked.length === 0}
          >
            <wa-icon slot="icon" name="broom"></wa-icon>
            Clear checked items
          </wa-dropdown-item>
          <wa-dropdown-item value="delete" variant="danger">
            <wa-icon slot="icon" name="trash-can"></wa-icon>
            Delete list
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
      <ConfirmDialog
        open={clearing}
        label={`Clear ${count(checked.length)} checked off “${list.name}”?`}
        confirmLabel="Clear"
        onConfirm={clearChecked}
        onClose={() => setClearing(false)}
      >
        They go from the list for both of you.
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
