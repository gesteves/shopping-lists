// The quantity of an item, from a text field (#104). This file imports only
// shared files.
import { QUANTITY_MAX } from "./ops";

/**
 * The quantity for the text of a field: a whole number from 1 to
 * QUANTITY_MAX. An empty field or a value that is not a number gives
 * `fallback`. A decimal goes down to a whole number.
 */
export function clampQuantity(raw: string, fallback: number): number {
  const text = raw.trim();
  const value = Number(text);
  if (text === "" || !Number.isFinite(value)) return fallback;
  return Math.min(QUANTITY_MAX, Math.max(1, Math.floor(value)));
}
