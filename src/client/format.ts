// Text for the UI: relative times and "who changed it" lines. The words
// are in the dictionary (src/copy).
import { copy, locale } from "@/copy";
import type { ItemRecord, UserRecord } from "@/shared/sync";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min. ago", "yesterday", "3 days ago", or a date. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (diff < MINUTE) return copy.time.justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  });
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (diff < 7 * DAY) return rtf.format(-Math.floor(diff / DAY), "day");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year:
      new Date(at).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  }).format(at);
}

function personName(users: Map<string, UserRecord>, id: string): string {
  return users.get(id)?.name ?? copy.people.someone;
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
    copy.item.added(
      personName(users, item.createdBy),
      relativeTime(item.createdAt, now),
    ),
  ];
  if (item.updatedAt !== item.createdAt || item.updatedVia === "mcp") {
    const name = personName(users, item.updatedBy);
    lines.push(
      copy.item.updated(
        item.updatedVia === "mcp" ? copy.people.viaClaude(name) : name,
        relativeTime(item.updatedAt, now),
      ),
    );
  }
  return lines;
}

/**
 * The initial of a name for an avatar: the first grapheme, in capitals. A
 * slice of the string can cut an emoji or a letter with an accent in two.
 */
export function initials(name: string): string {
  const first = new Intl.Segmenter(locale, { granularity: "grapheme" })
    .segment(name.trim())
    [Symbol.iterator]()
    .next().value?.segment;
  return (first ?? "").toLocaleUpperCase(locale);
}
