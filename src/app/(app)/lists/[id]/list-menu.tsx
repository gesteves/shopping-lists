"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { ListView } from "@/client/queries";
import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { MoreIcon } from "../../_components/icons";
import { DeleteDialog, RenameForm } from "../../_components/list-index";

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
  const [mode, setMode] = useState<"view" | "menu" | "rename">("view");
  const clearDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const menuId = useId();
  const clearTitleId = useId();
  const checked = items.filter((i) => i.checked).map((i) => i.id);
  const remaining = items.length - checked.length;

  if (mode === "rename") {
    return (
      <div className="mt-2">
        <RenameForm list={list} onDone={() => setMode("view")} />
      </div>
    );
  }

  async function uncheckAll() {
    setMode("view");
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
    clearDialog.current?.close();
    setMode("view");
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

  const action =
    "min-h-11 rounded-lg px-3 font-medium hover:bg-accent-soft disabled:opacity-40";

  return (
    <div className="mt-2">
      <div className="flex items-start gap-2">
        <h1 className="flex-1 text-4xl font-bold tracking-tight text-balance break-words">
          {list.name}
        </h1>
        <button
          type="button"
          aria-expanded={mode === "menu"}
          aria-controls={menuId}
          aria-label="List actions"
          onClick={() => setMode(mode === "menu" ? "view" : "menu")}
          className="mt-1 grid size-11 shrink-0 place-items-center rounded-xl text-ink-muted hover:text-ink"
        >
          <MoreIcon />
        </button>
      </div>
      {mode === "menu" && (
        <div
          id={menuId}
          className="mt-2 flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-2"
        >
          <button
            type="button"
            onClick={() => setMode("rename")}
            className={`${action} text-accent`}
          >
            Rename
          </button>
          <button
            type="button"
            disabled={checked.length === 0}
            onClick={uncheckAll}
            className={`${action} text-accent`}
          >
            Uncheck all
          </button>
          <button
            type="button"
            disabled={checked.length === 0}
            onClick={() => clearDialog.current?.showModal()}
            className={`${action} text-accent`}
          >
            Clear checked items
          </button>
          <button
            type="button"
            onClick={() => deleteDialog.current?.showModal()}
            className={`${action} text-danger`}
          >
            Delete list
          </button>
        </div>
      )}
      <dialog
        ref={clearDialog}
        aria-labelledby={clearTitleId}
        className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/40"
      >
        <h2 id={clearTitleId} className="text-xl font-semibold text-balance">
          Clear {count(checked.length)} checked off “{list.name}”?
        </h2>
        <p className="mt-2 text-ink-muted">
          They go from the list for both of you.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => clearDialog.current?.close()}
            className="min-h-11 rounded-lg px-4 font-medium text-accent hover:bg-accent-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={clearChecked}
            className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-accent-ink"
          >
            Clear
          </button>
        </div>
      </dialog>
      <DeleteDialog
        ref={deleteDialog}
        list={{ ...list, remaining }}
        onDeleted={() => router.push("/")}
      />
    </div>
  );
}
