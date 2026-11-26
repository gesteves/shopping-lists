// The sync engine: push the outbox, pull the changes, then rebuild the view.
// Only one run at a time. After a network or server error, it tries again
// with exponential backoff. After a 401, it keeps the outbox and waits for a
// trigger (the app comes to the front, the network comes back, or a poke).
import { opSchema, type Op } from "@/shared/ops";
import {
  MAX_PUSH_OPS,
  type PullResponse,
  type PushResponse,
  type RejectReason,
} from "@/shared/sync";
import { getMeta, type ClientDb } from "../db";
import { ensureClientId, rebuildView, savePullPage } from "./local";

export type SyncState =
  | "idle"
  | "syncing"
  /** The browser is offline. Sync starts again at the `online` event. */
  | "offline"
  /** A network or server error. A retry is scheduled. */
  | "error"
  /** The session ended. The outbox stays until the user signs in again. */
  | "unauthorized";

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: number | null;
}

/** The detail of a "rejected" event. "invalid" is a local schema failure. */
export interface RejectedDetail {
  op: Op;
  reason: RejectReason | "invalid";
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SyncEngineOptions {
  db: ClientDb;
  fetch?: typeof fetch;
  /** The origin of the API. Empty for the same origin. */
  baseUrl?: string;
  /** The wait after a local write before a sync. */
  debounceMs?: number;
  /** The first retry wait. Each failure doubles it, up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  timers?: Timers;
  isOnline?: () => boolean;
}

class UnauthorizedError extends Error {}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Most pages in one pull. A larger number is a server error. */
const MAX_PAGES = 1000;
/** Most pushes in one run. New writes go in the next run. */
const MAX_PUSHES = 50;

export class SyncEngine {
  /** "rejected" events, with a RejectedDetail. The UI shows a toast. */
  readonly events = new EventTarget();

  readonly #db: ClientDb;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #debounceMs: number;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timers: Timers;
  readonly #isOnline: () => boolean;

  #status: SyncStatus = { state: "idle", lastSyncAt: null };
  #listeners = new Set<() => void>();
  #running: Promise<void> | null = null;
  #again = false;
  #timer: unknown = null;
  #failures = 0;

  constructor(options: SyncEngineOptions) {
    this.#db = options.db;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#baseUrl = options.baseUrl ?? "";
    this.#debounceMs = options.debounceMs ?? 300;
    this.#backoffMs = options.backoffMs ?? 1000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.#timers = options.timers ?? defaultTimers;
    this.#isOnline =
      options.isOnline ??
      (() => typeof navigator === "undefined" || navigator.onLine !== false);
  }

  // Status, for useSyncExternalStore. The object changes at each update.

  getStatus = (): SyncStatus => this.#status;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #setStatus(patch: Partial<SyncStatus>) {
    this.#status = { ...this.#status, ...patch };
    for (const listener of this.#listeners) listener();
  }

  // Triggers

  /**
   * Start the browser triggers and sync now. It returns a function that
   * stops them.
   */
  start(): () => void {
    const onOnline = () => this.schedule(0);
    const onOffline = () => this.#setStatus({ state: "offline" });
    const onVisible = () => {
      if (document.visibilityState === "visible") this.schedule(0);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    // Ask the browser to keep the data. Safari can delete it otherwise.
    void navigator.storage?.persist?.().catch(() => undefined);
    this.schedule(0);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      this.#cancelTimer();
    };
  }

  /** The server has changes (#11). */
  poke(): void {
    this.schedule(0);
  }

  /** A local write. Sync after a short wait, for each burst of writes. */
  notifyWrite(): void {
    this.schedule(this.#debounceMs);
  }

  schedule(ms: number): void {
    this.#cancelTimer();
    this.#timer = this.#timers.set(() => {
      this.#timer = null;
      void this.sync();
    }, ms);
  }

  #cancelTimer() {
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = null;
  }

  // The run

  /**
   * Sync now. If a run is in progress, it runs one more time after it. The
   * promise does not reject: errors go to the status.
   */
  sync(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        let ok: boolean;
        do {
          this.#again = false;
          ok = await this.#runOnce();
          // After a failure, wait for the backoff timer.
        } while (this.#again && ok);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** One run. It gives false after a failure. */
  async #runOnce(): Promise<boolean> {
    if (!this.#isOnline()) {
      this.#setStatus({ state: "offline" });
      return false;
    }
    this.#cancelTimer();
    this.#setStatus({ state: "syncing" });
    try {
      await withLock(async () => {
        await this.#push();
        await this.#pull();
        await rebuildView(this.#db);
      });
      this.#failures = 0;
      this.#setStatus({ state: "idle", lastSyncAt: Date.now() });
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.#setStatus({ state: "unauthorized" });
        return false;
      }
      this.#failures++;
      const wait = Math.min(
        this.#maxBackoffMs,
        this.#backoffMs * 2 ** (this.#failures - 1),
      );
      this.#setStatus({ state: this.#isOnline() ? "error" : "offline" });
      this.schedule(wait);
      return false;
    }
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
    if (res.status === 401) throw new UnauthorizedError();
    return res;
  }

  async #push(): Promise<void> {
    const db = this.#db;
    const clientId = await ensureClientId(db);
    for (let round = 0; round < MAX_PUSHES; round++) {
      const entries = await db.outbox
        .orderBy("seq")
        .limit(MAX_PUSH_OPS)
        .toArray();
      if (entries.length === 0) return;

      const res = await this.#request("/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, ops: entries.map((e) => e.op) }),
      });
      if (res.status === 400) {
        // An op that was valid when the client made it, but is not valid
        // now (for example, after an app update). Drop it, or the outbox
        // stops for ever.
        const bad = entries.filter(
          (e) =>
            e.op.clientId !== clientId || !opSchema.safeParse(e.op).success,
        );
        if (bad.length === 0) throw new HttpError(400);
        await db.outbox.bulkDelete(bad.map((e) => e.seq!));
        for (const e of bad) this.#reject(e.op, "invalid");
        continue;
      }
      if (!res.ok) throw new HttpError(res.status);

      const body = (await res.json()) as PushResponse;
      await db.outbox.bulkDelete(entries.map((e) => e.seq!));
      entries.forEach((entry, i) => {
        const result = body.results[i];
        const final = result?.status === "duplicate" ? result.original : result;
        if (final?.status === "rejected") this.#reject(entry.op, final.reason);
      });
    }
  }

  async #pull(): Promise<void> {
    let cursor = (await getMeta(this.#db, "cursor")) ?? 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.#request(`/api/sync/pull?since=${cursor}`);
      if (!res.ok) throw new HttpError(res.status);
      const body = (await res.json()) as PullResponse;
      await savePullPage(this.#db, body);
      cursor = body.cursor;
      if (!body.hasMore) return;
    }
    throw new Error("Too many pull pages");
  }

  #reject(op: Op, reason: RejectedDetail["reason"]) {
    this.events.dispatchEvent(
      new CustomEvent<RejectedDetail>("rejected", { detail: { op, reason } }),
    );
  }
}

/** One sync at a time in all tabs, if the browser has Web Locks. */
async function withLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return fn();
  await locks.request("shopping-lists-sync", fn);
}
