// The add bar found a checked item with the same name (#120).
import type { ItemRecord } from "@/shared/sync";

/** What the user typed in the add bar. */
export interface Entry {
  name: string;
  quantity: number;
  notes: string;
  /** The add bar has no URL field. A copy (#140) gives one. */
  url?: string;
}

/**
 * The fields to change when the user unchecks a checked duplicate: the
 * fields that the user typed (not the defaults) and that are different
 * from the item. Undefined if there is no change. Empty notes, no URL, and
 * a quantity of 1 are the defaults, thus they do not clear the item.
 */
export function checkedFields(
  item: Pick<ItemRecord, "quantity" | "notes" | "url">,
  entry: Pick<Entry, "quantity" | "notes" | "url">,
): { quantity?: number; notes?: string; url?: string } | undefined {
  const fields: { quantity?: number; notes?: string; url?: string } = {};
  if (entry.quantity !== 1 && entry.quantity !== item.quantity) {
    fields.quantity = entry.quantity;
  }
  const notes = entry.notes.trim();
  if (notes && notes !== item.notes) fields.notes = notes;
  const url = entry.url?.trim();
  if (url && url !== item.url) fields.url = url;
  return Object.keys(fields).length > 0 ? fields : undefined;
}
