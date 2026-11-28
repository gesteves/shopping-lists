"use client";

import { mutate } from "@/client/sync";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import { expiryVariant } from "@/shared/expiry";
import type { ItemRecord } from "@/shared/sync";
import { isWebUrl, urlHost } from "@/shared/url";
import { EditingBadge } from "../../_components/presence";
import { useWaEvents } from "../../_components/wa";
import type { PickMode } from "./list-picker";

/**
 * One item: a large target to check it, and a "…" menu (#131): Visit page
 * and a divider (only with a URL, #140), Edit, Move, Copy, Out of stock (or
 * In stock), and Delete. An item with a URL shows its host below the notes. An
 * out-of-stock item has a badge. A checked item is never out of stock, thus its menu has no stock
 * item. An older checked item (#112) has a badge with the days until its
 * automatic delete. The name and the notes wrap, also a long word or URL
 * (#129): no truncation.
 */
export function ItemRow({
  item,
  onEdit,
  onPick,
  canMove,
  canCopy,
  expiresInDays,
}: {
  item: ItemRecord;
  onEdit: (item: ItemRecord) => void;
  /** Open the Move or Copy dialog for the item. */
  onPick: (item: ItemRecord, mode: PickMode) => void;
  /** False if there is no list to move to (#154: of the same kind). */
  canMove: boolean;
  /** False if there is no other list to copy to. */
  canCopy: boolean;
  /** Local calendar days until the delete, for an item in "Older items". */
  expiresInDays?: number;
}) {
  // A row from an older server has no outOfStockAt.
  const outOfStock = item.outOfStockAt != null;
  // A row from an older server has no url. The server accepts only web
  // URLs; check again before the app opens one.
  const url = item.url && isWebUrl(item.url) ? item.url : undefined;
  // A checked row looks quiet: the muted text color, not opacity. Opacity on
  // the text, or on the row with the expiry badge, fails the contrast scan.
  const quiet = item.checked ? "text-ink-muted" : "";
  function toggle() {
    void mutate({
      type: item.checked ? "uncheck" : "check",
      args: { itemId: item.id },
    });
  }

  async function remove() {
    await mutate({ type: "deleteItem", args: { itemId: item.id } });
    showToast({
      message: copy.item.deleted(item.name),
      action: {
        label: copy.common.undo,
        run: () =>
          void mutate({ type: "restoreItem", args: { itemId: item.id } }),
      },
    });
  }

  async function markOutOfStock() {
    await mutate({ type: "markOutOfStock", args: { itemId: item.id } });
    // Offer to get it at another store. To decline, do nothing: the toast
    // closes itself.
    if (!canMove && !canCopy) return;
    showToast({
      message: copy.item.markedOutOfStock(item.name),
      icon: "cart-circle-xmark",
      duration: 10_000,
      actions: [
        ...(canMove
          ? [{ label: copy.item.move, run: () => onPick(item, "move") }]
          : []),
        ...(canCopy
          ? [{ label: copy.item.copy, run: () => onPick(item, "copy") }]
          : []),
      ],
    });
  }

  const menu = useWaEvents<HTMLElement>({
    "wa-select": (event) => {
      const value = (event as CustomEvent<{ item: { value: string } }>).detail
        .item.value;
      if (value === "edit") onEdit(item);
      // In the select event of the tap, thus the browser allows the tab.
      if (value === "visit" && url)
        window.open(url, "_blank", "noopener,noreferrer");
      if (value === "move" || value === "copy") onPick(item, value);
      if (value === "out-of-stock") void markOutOfStock();
      if (value === "in-stock")
        void mutate({ type: "markInStock", args: { itemId: item.id } });
      if (value === "delete") void remove();
    },
  });

  return (
    <li className="flex items-stretch rounded-xl border border-line bg-surface">
      <button
        type="button"
        role="checkbox"
        aria-checked={item.checked}
        data-name={item.name}
        onClick={toggle}
        className="flex min-h-16 min-w-0 flex-1 items-center gap-4 rounded-xl px-4 py-3 text-left"
      >
        <span
          aria-hidden="true"
          className={`grid size-7 shrink-0 place-items-center rounded-full border-2 ${item.checked ? "border-accent bg-accent text-accent-ink" : "border-ink-muted"} ${item.checked ? "opacity-60" : ""}`}
        >
          {item.checked && <wa-icon name="check" className="text-sm"></wa-icon>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          {/* Inline flow, not flex: the badge has no text baseline, thus flex
              baseline alignment puts it too low. The badge goes after the
              last line of the name, in a box that is one line high. */}
          <span className={`text-lg leading-snug wrap-anywhere ${quiet}`}>
            <span
              className={`font-medium ${item.checked ? "line-through decoration-2" : ""}`}
            >
              {item.name}
            </span>
            {item.quantity > 1 && (
              <span className="ms-2 inline-flex h-lh items-center align-top">
                <wa-badge
                  pill
                  appearance="filled"
                  className="text-xs tabular-nums"
                >
                  <span className="sr-only">{copy.item.quantityPrefix}</span>
                  {copy.item.quantity(item.quantity)}
                </wa-badge>
              </span>
            )}
          </span>
          <EditingBadge itemId={item.id} />
          {item.notes && (
            <span className="text-sm wrap-anywhere text-ink-muted">
              {item.notes}
            </span>
          )}
          {url && (
            <span className="flex items-start gap-1.5 text-sm text-ink-muted">
              <span className="inline-flex h-lh shrink-0 items-center">
                <wa-icon name="link"></wa-icon>
              </span>
              <span className="min-w-0 wrap-anywhere">
                <span className="sr-only">{copy.item.linkPrefix}</span>
                {urlHost(url)}
              </span>
            </span>
          )}
          {outOfStock && (
            <span className="mt-1">
              <wa-badge
                variant="warning"
                appearance="filled"
                className="text-xs"
              >
                <wa-icon slot="start" name="cart-circle-xmark"></wa-icon>
                {copy.item.outOfStock}
              </wa-badge>
            </span>
          )}
          {expiresInDays !== undefined && (
            <span className="mt-1">
              <wa-badge
                variant={expiryVariant(expiresInDays)}
                appearance="filled"
                className="text-xs"
              >
                {copy.item.expiresIn(expiresInDays)}
              </wa-badge>
            </span>
          )}
        </span>
      </button>
      {/* <wa-dropdown> is display: contents. The button is the flex item. */}
      <wa-dropdown ref={menu} placement="bottom-end">
        <wa-button
          slot="trigger"
          appearance="plain"
          size="l"
          className="me-2 self-center"
        >
          <wa-icon name="ellipsis" label={copy.item.more(item.name)}></wa-icon>
        </wa-button>
        {/* Visit page leaves the app, thus it is first and apart from the
            changes to the item. */}
        {url && (
          <>
            <wa-dropdown-item value="visit">
              <wa-icon slot="icon" name="arrow-up-right-from-square"></wa-icon>
              {copy.item.visitPage}
            </wa-dropdown-item>
            <wa-divider></wa-divider>
          </>
        )}
        <wa-dropdown-item value="edit">
          <wa-icon slot="icon" name="pencil"></wa-icon>
          {copy.item.edit}
        </wa-dropdown-item>
        <wa-dropdown-item value="move" disabled={!canMove}>
          <wa-icon slot="icon" name="swap"></wa-icon>
          {copy.item.move}
        </wa-dropdown-item>
        <wa-dropdown-item value="copy" disabled={!canCopy}>
          <wa-icon slot="icon" name="copy"></wa-icon>
          {copy.item.copy}
        </wa-dropdown-item>
        {!item.checked &&
          (outOfStock ? (
            <wa-dropdown-item value="in-stock">
              <wa-icon slot="icon" name="cart-circle-check"></wa-icon>
              {copy.item.inStock}
            </wa-dropdown-item>
          ) : (
            <wa-dropdown-item value="out-of-stock">
              <wa-icon slot="icon" name="cart-circle-xmark"></wa-icon>
              {copy.item.outOfStock}
            </wa-dropdown-item>
          ))}
        <wa-divider></wa-divider>
        <wa-dropdown-item value="delete" variant="danger">
          <wa-icon slot="icon" name="trash-can"></wa-icon>
          {copy.common.delete}
        </wa-dropdown-item>
      </wa-dropdown>
    </li>
  );
}
