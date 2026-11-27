"use client";

import { mutate } from "@/client/sync";
import { copy } from "@/copy";
import type { ItemRecord } from "@/shared/sync";
import { EditingBadge } from "../../_components/presence";

/** One item: a large target to check it, and a button for the sheet. */
export function ItemRow({
  item,
  onEdit,
}: {
  item: ItemRecord;
  onEdit: (item: ItemRecord) => void;
}) {
  function toggle() {
    void mutate({
      type: item.checked ? "uncheck" : "check",
      args: { itemId: item.id },
    });
  }

  return (
    <li
      className={`flex items-stretch rounded-xl border border-line bg-surface ${item.checked ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={item.checked}
        data-name={item.name}
        onClick={toggle}
        className="flex min-h-16 flex-1 items-center gap-4 rounded-xl px-4 py-3 text-left"
      >
        <span
          aria-hidden="true"
          className={`grid size-7 shrink-0 place-items-center rounded-full border-2 ${item.checked ? "border-accent bg-accent text-accent-ink" : "border-ink-muted"}`}
        >
          {item.checked && <wa-icon name="check" className="text-sm"></wa-icon>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          {/* Inline flow, not flex: the badge has no text baseline, thus flex
              baseline alignment puts it too low. The badge goes after the
              last line of the name, in a box that is one line high. */}
          <span className="text-lg leading-snug break-words">
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
            <span className="truncate text-sm text-ink-muted">
              {item.notes}
            </span>
          )}
        </span>
      </button>
      <wa-button
        appearance="plain"
        size="l"
        onClick={() => onEdit(item)}
        className="me-2 self-center"
      >
        <wa-icon name="pen" label={copy.item.edit(item.name)}></wa-icon>
      </wa-button>
    </li>
  );
}
