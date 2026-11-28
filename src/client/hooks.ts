// React hooks for the local data. They read the view, thus they work the same
// online and offline. A hook gives undefined until the first read is done.
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useSyncExternalStore } from "react";
import type { PresenceEntry } from "@/shared/presence";
import type { ListRecord, UserRecord } from "@/shared/sync";
import { getClientDb, getMeta } from "./db";
import { presenceStore, reportPresence, type LocalPresence } from "./presence";
import {
  readList,
  readListSummaries,
  readLists,
  readOtherUserNames,
  type ListSummary,
  type ListView,
} from "./queries";
import { buildCandidates, type Candidate } from "./suggest";
import {
  getSyncEngine,
  type MergedDetail,
  type RejectedDetail,
  type SyncStatus,
} from "./sync";

/** The lists that are not deleted, by name. */
export function useLists(): ListRecord[] | undefined {
  return useLiveQuery(() => readLists(getClientDb()), []);
}

/** The lists that are not deleted, by name, each with its unchecked count. */
export function useListSummaries(): ListSummary[] | undefined {
  return useLiveQuery(() => readListSummaries(getClientDb()), []);
}

/**
 * A list and its items: unchecked first, then the last updated first. Null
 * if the list does not exist or is deleted.
 */
export function useList(id: string): ListView | null | undefined {
  return useLiveQuery(() => readList(getClientDb(), id), [id]);
}

/** The number of changes that the server does not have yet. */
export function usePendingCount(): number | undefined {
  // An acked op is on the server: it is not a change to sync.
  return useLiveQuery(
    () =>
      getClientDb()
        .outbox.filter((e) => !e.acked)
        .count(),
    [],
  );
}

/** All users, by ID: the names and the avatars. */
export function useUsers(): Map<string, UserRecord> | undefined {
  return useLiveQuery(
    async () =>
      new Map((await getClientDb().users.toArray()).map((u) => [u.id, u])),
    [],
  );
}

/** The names of the other users, by name. */
export function useOtherUserNames(): string[] | undefined {
  return useLiveQuery(() => readOtherUserNames(getClientDb()), []);
}

const SERVER_STATUS: SyncStatus = { state: "idle", lastSyncAt: null };

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (listener) => getSyncEngine().subscribe(listener),
    () => getSyncEngine().getStatus(),
    () => SERVER_STATUS,
  );
}

function useEngineEvent<T>(type: string, handler: (detail: T) => void) {
  useEffect(() => {
    const listener = (event: Event) =>
      handler((event as CustomEvent<T>).detail);
    const events = getSyncEngine().events;
    events.addEventListener(type, listener);
    return () => events.removeEventListener(type, listener);
  }, [type, handler]);
}

/** Call `handler` for each op that the server rejected. Give a stable
 * handler (useCallback). */
export function useRejectedOps(handler: (detail: RejectedDetail) => void) {
  useEngineEvent("rejected", handler);
}

/** Call `handler` for each add that the server merged into an item. */
export function useMergedOps(handler: (detail: MergedDetail) => void) {
  useEngineEvent("merged", handler);
}

/** The ID of the signed-in user, or undefined until it is known. */
export function useMyUserId(): string | undefined {
  return useLiveQuery(() => getMeta(getClientDb(), "userId"), []);
}

/**
 * Autocomplete candidates from the items on this device. On a shared list,
 * the names from private lists stay out (#154): a tap on one adds a gift
 * to a list that the other person sees, and notifies them.
 */
export function useSuggestionCandidates(
  listId: string,
): Candidate[] | undefined {
  return useLiveQuery(async () => {
    const db = getClientDb();
    const [items, lists] = await Promise.all([
      db.items.toArray(),
      db.lists.toArray(),
    ]);
    const privateIds = new Set(
      lists.filter((l) => l.private === true).map((l) => l.id),
    );
    if (privateIds.has(listId)) return buildCandidates(items);
    return buildCandidates(items.filter((i) => !privateIds.has(i.listId)));
  }, [listId]);
}

/** What the other people show now. Empty while offline. */
export function usePresence(): PresenceEntry[] {
  return useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
    presenceStore.getServerSnapshot,
  );
}

/** Tell the other person what this screen shows. Clears on unmount. */
export function useReportPresence({ listId, editingItemId }: LocalPresence) {
  useEffect(() => {
    reportPresence({ listId, editingItemId });
  }, [listId, editingItemId]);
  useEffect(
    () => () => reportPresence({ listId: null, editingItemId: null }),
    [],
  );
}
