"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { useList, useLists, useReportPresence } from "@/client/hooks";
import { splitOlder } from "@/client/queries";
import { useNow } from "@/client/use-now";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import { daysLeft, expiresAt } from "@/shared/expiry";
import type { ItemRecord } from "@/shared/sync";
import { AddBar } from "./add-bar";
import { ItemRow } from "./item-row";
import { ItemSheet } from "./item-sheet";
import { ListPicker, pickTargets, type PickMode } from "./list-picker";
import { ListHeader } from "./list-menu";
import { ListSwitches } from "./list-switches";

/** One list: its items (unchecked first), the add bar, and the item sheet. */
export function ListView() {
  // The ID from the URL, not from useParams(): offline, the service worker
  // can give the HTML of the list shell for each list (#103). The pathname
  // follows the URL of the browser.
  const id = decodeURIComponent(usePathname().split("/")[2] ?? "");
  const view = useList(id);
  const [editing, setEditing] = useState<ItemRecord | null>(null);
  const [picking, setPicking] = useState<{
    id: string;
    mode: PickMode;
  } | null>(null);
  const lists = useLists() ?? [];
  const canMove = pickTargets(lists, id, "move").length > 0;
  const canCopy = pickTargets(lists, id, "copy").length > 0;
  // The newest copy of the item. If it left the list, the dialog closes.
  const pickItem = picking && view?.items.find((i) => i.id === picking.id);
  const pickMode = picking?.mode;
  // A stable object: the dialog keeps the last request in its state.
  const pickRequest = useMemo(
    () => (pickItem && pickMode ? { item: pickItem, mode: pickMode } : null),
    [pickItem, pickMode],
  );
  const onPick = (item: ItemRecord, mode: PickMode) =>
    setPicking({ id: item.id, mode });

  // Keep the sheet on the newest copy of the item (sync can change it).
  const live = editing && view?.items.find((i) => i.id === editing.id);
  // The item went from the list on another device while the sheet is open.
  // Close the sheet: a save would bring the item back. The sheet calls
  // onClose when it is hidden.
  const gone = editing !== null && view !== undefined && !live;
  const current = gone ? null : (live ?? editing);
  const goneName = gone ? editing.name : null;
  useEffect(() => {
    if (goneName !== null)
      showToast({ message: copy.itemSheet.gone(goneName) });
  }, [goneName]);
  const remaining = view?.items.filter((i) => !i.checked).length ?? 0;
  // The checked items that the server deletes soon go in "Older items"
  // (#112), at the bottom.
  const now = useNow();
  const { current: shownItems, older } = splitOlder(view?.items ?? [], now);
  const olderId = useId();
  useReportPresence({
    listId: view ? view.list.id : null,
    editingItemId: current?.id ?? null,
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col pt-4 lg:pt-6">
      <Link
        href="/"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-md pr-2 font-medium text-accent lg:hidden"
      >
        <wa-icon name="chevron-left"></wa-icon>
        {copy.list.back}
      </Link>
      {view === undefined ? null : view === null ? (
        <p className="mt-4 text-lg text-ink-muted">{copy.list.notFound}</p>
      ) : (
        <>
          <ListHeader view={view} />
          <ListSwitches
            listId={view.list.id}
            isPrivate={view.list.private === true}
          />
          {/* Keep the live region in the DOM, so that a screen reader reads the callout when it shows. */}
          <div aria-live="polite">
            {view.items.length === 0 ? (
              <wa-callout variant="neutral" size="small" className="mt-4">
                <wa-icon slot="icon" name="cart-shopping"></wa-icon>
                {copy.list.empty}
              </wa-callout>
            ) : remaining === 0 ? (
              <wa-callout variant="brand" size="small" className="mt-4">
                <wa-icon slot="icon" name="circle-check"></wa-icon>
                {copy.list.allChecked}
              </wa-callout>
            ) : null}
          </div>
          <ul
            aria-label={copy.list.items}
            className="mt-5 mb-4 flex flex-col gap-2"
          >
            {shownItems.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                onEdit={setEditing}
                onPick={onPick}
                canMove={canMove}
                canCopy={canCopy}
              />
            ))}
          </ul>
          {older.length > 0 && now !== null && (
            <section aria-labelledby={olderId} className="mb-4">
              <h2
                id={olderId}
                className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
              >
                {copy.list.olderItems}
              </h2>
              <ul aria-labelledby={olderId} className="flex flex-col gap-2">
                {older.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onEdit={setEditing}
                    onPick={onPick}
                    canMove={canMove}
                    canCopy={canCopy}
                    expiresInDays={daysLeft(expiresAt(item.checkedAt!), now)}
                  />
                ))}
              </ul>
            </section>
          )}
          <AddBar listId={view.list.id} items={view.items} />
          <ItemSheet item={current} onClose={() => setEditing(null)} />
          <ListPicker request={pickRequest} onClose={() => setPicking(null)} />
        </>
      )}
    </div>
  );
}
