"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useList } from "@/client/hooks";
import type { ItemRecord } from "@/shared/sync";
import { BackIcon } from "../../_components/icons";
import { AddBar } from "./add-bar";
import { ItemRow } from "./item-row";
import { ItemSheet } from "./item-sheet";

/** One list: its items (unchecked first), the add bar, and the item sheet. */
export function ListView() {
  const { id } = useParams<{ id: string }>();
  const view = useList(id);
  const [editing, setEditing] = useState<ItemRecord | null>(null);

  // Keep the sheet on the newest copy of the item (sync can change it).
  const current = editing
    ? (view?.items.find((i) => i.id === editing.id) ?? editing)
    : null;
  const remaining = view?.items.filter((i) => !i.checked).length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col pt-4 lg:pt-6">
      <Link
        href="/"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-md pr-2 font-medium text-accent lg:hidden"
      >
        <BackIcon />
        Lists
      </Link>
      {view === undefined ? null : view === null ? (
        <p className="mt-4 text-lg text-ink-muted">
          This list doesn’t exist or was deleted.
        </p>
      ) : (
        <>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-balance break-words">
            {view.list.name}
          </h1>
          <p className="mt-1 text-ink-muted tabular-nums" aria-live="polite">
            {view.items.length === 0
              ? "Nothing on this list yet. Add the first item below."
              : remaining === 0
                ? "Everything is checked off."
                : `${remaining} to get`}
          </p>
          <ul aria-label="Items" className="mt-5 mb-4 flex flex-col gap-2">
            {view.items.map((item) => (
              <ItemRow key={item.id} item={item} onEdit={setEditing} />
            ))}
          </ul>
          <AddBar listId={view.list.id} />
          <ItemSheet item={current} onClose={() => setEditing(null)} />
        </>
      )}
    </div>
  );
}
