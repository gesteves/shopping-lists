// The text of a notification for one event (#16). See "Notification
// templates" in docs/PLAN.md. The sentences are in the dictionary
// (`push` in src/copy/en.ts). Keep them the same as the plan.
import { copy } from "@/copy";
import type { ActivityEvent } from "./types";

export { article } from "@/copy/en";

/** The name of the person, with "(via Claude)" for an MCP change. */
export function who(name: string, via: ActivityEvent["via"]): string {
  return via === "mcp" ? copy.people.viaClaude(name) : name;
}

/** The sentence for one event. */
export function renderEvent(event: ActivityEvent, actorName: string): string {
  const s = event.snapshot;
  return copy.push.events[event.type]({
    who: who(actorName, event.via),
    list: s.listName,
    item: s.itemName ?? "",
    oldList: s.oldName ?? s.listName,
    fromList: s.fromListName ?? "",
  });
}

/**
 * The text when Claude gives none (#89): the sentence of the event for one
 * event, else "Sam made 3 changes to the “Costco” list." or "… to 2
 * lists.".
 */
export function renderFallback(
  events: ActivityEvent[],
  actorName: string,
): string {
  if (events.length === 1) return renderEvent(events[0], actorName);
  const lists = new Map(events.map((e) => [e.listId, e.snapshot.listName]));
  return copy.push.burst(
    who(actorName, events[0].via),
    events.length,
    lists.size,
    [...lists.values()][0],
  );
}
