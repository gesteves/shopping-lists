// Presence (#12): which list each device shows, and which item it edits.
// It is in memory only: the machine is one process (see docs/PLAN.md).
import "server-only";
import {
  PRESENCE_TTL_MS,
  type PresenceEntry,
  type PresenceInput,
  type PresenceSnapshot,
} from "@/shared/presence";
import { bus } from "./bus";

/** How often the store removes expired entries. */
const SWEEP_MS = 5_000;

interface Entry extends PresenceEntry {
  expiresAt: number;
}

export class PresenceStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #emit: (snapshot: PresenceSnapshot) => void;

  constructor(
    options: {
      now?: () => number;
      emit?: (snapshot: PresenceSnapshot) => void;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#emit = options.emit ?? ((snapshot) => bus.emit("presence", snapshot));
  }

  /** Save the presence of a device. It broadcasts only on a change. */
  set(userId: string, input: PresenceInput): void {
    const key = `${userId}:${input.clientId}`;
    const before = this.#entries.get(key);
    if (input.listId === null && input.editingItemId === null) {
      if (this.#entries.delete(key)) this.#broadcast();
      return;
    }
    this.#entries.set(key, {
      userId,
      clientId: input.clientId,
      listId: input.listId,
      editingItemId: input.editingItemId,
      expiresAt: this.#now() + PRESENCE_TTL_MS,
    });
    if (
      before?.listId !== input.listId ||
      before?.editingItemId !== input.editingItemId
    ) {
      this.#broadcast();
    }
  }

  /** Remove the entries with no heartbeat in the TTL. */
  sweep(): void {
    const now = this.#now();
    let removed = false;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        removed = true;
      }
    }
    if (removed) this.#broadcast();
  }

  snapshot(): PresenceSnapshot {
    const now = this.#now();
    return {
      entries: [...this.#entries.values()]
        .filter((e) => e.expiresAt > now)
        .map(({ userId, clientId, listId, editingItemId }) => ({
          userId,
          clientId,
          listId,
          editingItemId,
        })),
    };
  }

  #broadcast() {
    this.#emit(this.snapshot());
  }
}

const KEY = Symbol.for("shopping-lists.presence");
const store = globalThis as typeof globalThis & { [KEY]?: PresenceStore };

/** The store of the process, with its sweep timer. */
export function getPresence(): PresenceStore {
  if (!store[KEY]) {
    const presence = new PresenceStore();
    setInterval(() => presence.sweep(), SWEEP_MS).unref();
    store[KEY] = presence;
  }
  return store[KEY];
}
