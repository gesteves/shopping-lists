// The lists that the user muted (#15). The list page and Settings use the
// same hook. The server keeps the mutes, thus they apply on all devices.
import { useCallback, useEffect, useState } from "react";

async function api(init?: RequestInit) {
  const res = await fetch("/api/push/mutes", {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/**
 * The muted list IDs, and a function that mutes or unmutes a list. The set
 * is undefined until the server answers, or if the request fails.
 */
export function useMutedLists() {
  const [muted, setMuted] = useState<Set<string>>();

  useEffect(() => {
    void api()
      .then(({ listIds }: { listIds: string[] }) => setMuted(new Set(listIds)))
      .catch(() => undefined);
  }, []);

  /** Change the mute of a list. The set changes after the server saves it. */
  const setListMuted = useCallback(async (listId: string, next: boolean) => {
    await api({
      method: "PUT",
      body: JSON.stringify({ listId, muted: next }),
    });
    setMuted((m) => {
      const copy = new Set(m);
      if (next) copy.add(listId);
      else copy.delete(listId);
      return copy;
    });
  }, []);

  return { muted, setListMuted };
}
