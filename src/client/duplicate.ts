// The add bar found a checked item with the same name (#120).
import type { ItemRecord } from "@/shared/sync";

/** What the user typed in the add bar. */
export interface Entry {
  name: string;
  quantity: number;
  notes: string;
}

/**
 * The fields to change when the user unchecks a checked duplicate: the
 * fields that the user typed (not the defaults) and that are different
 * from the item. Undefined if there is no change. Empty notes and a
 * quantity of 1 are the defaults, thus they do not clear the item.
 */
export function checkedFields(
  item: Pick<ItemRecord, "quantity" | "notes">,
  entry: Pick<Entry, "quantity" | "notes">,
): { quantity?: number; notes?: string } | undefined {
  const fields: { quantity?: number; notes?: string } = {};
  if (entry.quantity !== 1 && entry.quantity !== item.quantity) {
    fields.quantity = entry.quantity;
  }
  const notes = entry.notes.trim();
  if (notes && notes !== item.notes) fields.notes = notes;
  return Object.keys(fields).length > 0 ? fields : undefined;
}
