"use client";

import { mutate } from "@/client/sync";
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
          <span className="flex items-baseline gap-2">
            <span
              className={`text-lg leading-snug font-medium break-words ${item.checked ? "line-through decoration-2" : ""}`}
            >
              {item.name}
            </span>
            {item.quantity > 1 && (
              <wa-badge
                pill
                appearance="filled"
                className="shrink-0 tabular-nums"
              >
                <span className="sr-only">quantity </span>×{item.quantity}
              </wa-badge>
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
        className="self-center"
      >
        <wa-icon name="pen" label={`Edit ${item.name}`}></wa-icon>
      </wa-button>
    </li>
  );
}
