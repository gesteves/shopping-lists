"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useList, useReportPresence } from "@/client/hooks";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import type { ItemRecord } from "@/shared/sync";
import { AddBar } from "./add-bar";
import { ItemRow } from "./item-row";
import { ItemSheet } from "./item-sheet";
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
          <ListSwitches listId={view.list.id} />
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
            {view.items.map((item) => (
              <ItemRow key={item.id} item={item} onEdit={setEditing} />
            ))}
          </ul>
          <AddBar listId={view.list.id} items={view.items} />
          <ItemSheet item={current} onClose={() => setEditing(null)} />
        </>
      )}
    </div>
  );
}
