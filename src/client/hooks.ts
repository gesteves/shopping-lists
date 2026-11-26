// React hooks for the local data. They read the view, thus they work the same
// online and offline. A hook gives undefined until the first read is done.
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useSyncExternalStore } from "react";
import type { ListRecord, UserRecord } from "@/shared/sync";
import { getClientDb } from "./db";
import {
  readList,
  readListSummaries,
  readLists,
  type ListSummary,
  type ListView,
} from "./queries";
import { getSyncEngine, type RejectedDetail, type SyncStatus } from "./sync";

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
  return useLiveQuery(() => getClientDb().outbox.count(), []);
}

/** All users, by ID: the names and the avatars. */
export function useUsers(): Map<string, UserRecord> | undefined {
  return useLiveQuery(
    async () =>
      new Map((await getClientDb().users.toArray()).map((u) => [u.id, u])),
    [],
  );
}

const SERVER_STATUS: SyncStatus = { state: "idle", lastSyncAt: null };

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (listener) => getSyncEngine().subscribe(listener),
    () => getSyncEngine().getStatus(),
    () => SERVER_STATUS,
  );
}

/** Call `handler` for each op that the server rejected. */
export function useRejectedOps(handler: (detail: RejectedDetail) => void) {
  useEffect(() => {
    const listener = (event: Event) =>
      handler((event as CustomEvent<RejectedDetail>).detail);
    const events = getSyncEngine().events;
    events.addEventListener("rejected", listener);
    return () => events.removeEventListener("rejected", listener);
  }, [handler]);
}
