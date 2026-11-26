// Presence on the client (#12). It sends what this device shows, and keeps
// what the other devices show (from the `presence` SSE events).
import { PRESENCE_HEARTBEAT_MS, type PresenceEntry } from "@/shared/presence";

export interface LocalPresence {
  listId: string | null;
  editingItemId: string | null;
}

const NONE: LocalPresence = { listId: null, editingItemId: null };

// What the other devices show. Empty while the stream is closed: presence
// is hidden while offline.
let entries: PresenceEntry[] = [];
const listeners = new Set<() => void>();

export const presenceStore = {
  getSnapshot: (): PresenceEntry[] => entries,
  getServerSnapshot: (): PresenceEntry[] => [],
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Called with each `presence` event, and with [] when the stream closes. */
  set(next: PresenceEntry[]): void {
    entries = next;
    for (const listener of listeners) listener();
  },
};

// What this device shows.
let current: LocalPresence = NONE;
let sender: ((state: LocalPresence) => void) | null = null;

/** Tell the other person what this device shows now. */
export function reportPresence(state: LocalPresence): void {
  if (
    state.listId === current.listId &&
    state.editingItemId === current.editingItemId
  ) {
    return;
  }
  current = state;
  sender?.(current);
}

export interface PresenceOptions {
  clientId: string;
  fetch?: typeof fetch;
  document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Start sending. It returns a function that stops it. */
export function startPresence(options: PresenceOptions): () => void {
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  const doc = options.document ?? document;
  const every = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery =
    options.clearInterval ??
    ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const send = (state: LocalPresence) => {
    void doFetch("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: options.clientId, ...state }),
      // The clear on hide must arrive after the page goes.
      keepalive: true,
    }).catch(() => undefined);
  };
  const visible = () => doc.visibilityState === "visible";

  sender = (state) => {
    if (visible()) send(state);
  };
  const heartbeat = every(() => {
    if (visible() && current.listId !== null) send(current);
  }, PRESENCE_HEARTBEAT_MS);
  const onVisibility = () => send(visible() ? current : NONE);
  doc.addEventListener("visibilitychange", onVisibility);
  // Safari fires no visibilitychange for a full page load. The page goes,
  // thus clear now and not after the TTL.
  const onPageHide = () => send(NONE);
  const win = typeof window === "undefined" ? undefined : window;
  win?.addEventListener("pagehide", onPageHide);
  if (current.listId !== null) sender(current);

  return () => {
    sender = null;
    stopEvery(heartbeat);
    doc.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pagehide", onPageHide);
    send(NONE);
  };
}
