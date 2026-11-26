// The text of a notification for one event (#16). See "Notification
// templates" in docs/PLAN.md. Keep the strings the same as the plan.
import type { ActivityEvent } from "./types";

const q = (s: string) => `“${s}”`;

/**
 * "a" or "an" before a name, from its first sound: a vowel letter, or a
 * number said with a vowel. Names like "Uber" or "Hour" can be wrong.
 */
export function article(name: string): "a" | "an" {
  const s = name.trim().toLowerCase();
  // "8…" is "eight…"; "11" and "18" are "eleven" and "eighteen".
  if (/^8/.test(s) || /^1[18](\D|$)/.test(s)) return "an";
  return /^[aeiou]/.test(s) ? "an" : "a";
}

/** The name of the person, with "(via Claude)" for an MCP change. */
export function who(name: string, via: ActivityEvent["via"]): string {
  return via === "mcp" ? `${name} (via Claude)` : name;
}

/** The sentence for one event. */
export function renderEvent(event: ActivityEvent, actorName: string): string {
  const name = who(actorName, event.via);
  const s = event.snapshot;
  const list = q(s.listName);
  const item = q(s.itemName ?? "");
  switch (event.type) {
    case "createList":
      return `${name} created ${article(s.listName)} ${list} list`;
    case "deleteList":
      return `${name} deleted the ${list} list`;
    case "renameList":
      return `${name} renamed the ${q(s.oldName ?? s.listName)} list to ${list}`;
    case "restoreList":
      return `${name} restored the ${list} list`;
    case "addItem":
      return `${name} added ${item} to the ${list} list`;
    case "updateItem":
      return `${name} updated ${item} in the ${list} list`;
    case "deleteItem":
      return `${name} removed ${item} from the ${list} list`;
    case "restoreItem":
      return `${name} put ${item} back on the ${list} list`;
    case "check":
      return `${name} checked ${item} off the ${list} list`;
    case "uncheck":
      return `${name} unchecked ${item} in the ${list} list`;
    case "moveItem":
      return `${name} moved ${item} from the ${q(s.fromListName ?? "")} list to the ${list} list`;
    case "clearChecked":
      return `${name} cleared checked items from the ${list} list`;
    case "uncheckAll":
      return `${name} unchecked everything in the ${list} list`;
  }
}

/**
 * The text when more than one event is left: "Sam made 3 changes to the
 * “Costco” list", or "… to 2 lists". #17 replaces it with a summary from
 * Claude, and keeps it as the fallback.
 */
export function renderFallback(
  events: ActivityEvent[],
  actorName: string,
): string {
  const name = who(actorName, events[0].via);
  const lists = new Map(events.map((e) => [e.listId, e.snapshot.listName]));
  const n = events.length;
  const where =
    lists.size === 1
      ? `the ${q([...lists.values()][0])} list`
      : `${lists.size} lists`;
  return `${name} made ${n} changes to ${where}`;
}
