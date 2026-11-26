// Text for the UI: relative times and "who changed it" lines.
import type { ItemRecord, UserRecord } from "@/shared/sync";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min. ago", "yesterday", "3 days ago", or a date. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (diff < MINUTE) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", {
    numeric: "auto",
    style: "short",
  });
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (diff < 7 * DAY) return rtf.format(-Math.floor(diff / DAY), "day");
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year:
      new Date(at).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  }).format(at);
}

function personName(users: Map<string, UserRecord>, id: string): string {
  return users.get(id)?.name ?? "Someone";
}

/**
 * The metadata lines of an item: "Added by Sam · 5 min. ago", and
 * "Updated by Alex (via Claude) · just now" if it changed after the add.
 */
export function itemHistory(
  item: ItemRecord,
  users: Map<string, UserRecord>,
  now: number = Date.now(),
): string[] {
  const lines = [
    `Added by ${personName(users, item.createdBy)} · ${relativeTime(item.createdAt, now)}`,
  ];
  if (item.updatedAt !== item.createdAt || item.updatedVia === "mcp") {
    const via = item.updatedVia === "mcp" ? " (via Claude)" : "";
    lines.push(
      `Updated by ${personName(users, item.updatedBy)}${via} · ${relativeTime(item.updatedAt, now)}`,
    );
  }
  return lines;
}
