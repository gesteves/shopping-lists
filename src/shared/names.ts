// Name normalization for dedupe (#5, #14). This file must import nothing.

/**
 * The dedupe key of an item name: Unicode NFC, trimmed, each run of white
 * space changed to one space, and lowercase. "  Oat   Milk " and "oat milk"
 * give the same key.
 */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}
