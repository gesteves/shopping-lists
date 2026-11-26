// Test helpers for the notifier. Not used at runtime.
import type { ActivitySnapshot } from "@/db/schema";
import type { OpType } from "@/shared/ops";
import type { ActivityEvent } from "@/server/notify/types";

let id = 0;

/** An event for tests. */
export function ev(
  type: OpType,
  snapshot: Partial<ActivitySnapshot> & { listName?: string },
  ids: { listId?: string; itemId?: string | null } = {},
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  id++;
  return {
    id,
    actorId: "sam",
    via: "app",
    type,
    listId: ids.listId ?? "list-1",
    itemId: ids.itemId === undefined ? "item-1" : ids.itemId,
    snapshot: { listName: "Whole Foods", ...snapshot },
    at: id * 1000,
    ...extra,
  };
}
