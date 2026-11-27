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
import { getMeta, type ClientDb, type OutboxEntry } from "../db";
import { ensureClientId, rebuildView, restampOps, savePullPage } from "./local";

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

/** The detail of a "merged" event: the server kept `into`, not the new row. */
export interface MergedDetail {
  op: Op;
  into: string;
  /** True if the server unchecked the item. */
  changed: boolean;
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
  /** A request that takes longer fails as a network error. */
  timeoutMs?: number;
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

/** Set to true when a step changes the local data. */
interface RunState {
  dirty: boolean;
}

export class SyncEngine {
  /** "rejected" (RejectedDetail) and "merged" (MergedDetail) events. The UI
   * shows a toast. */
  readonly events = new EventTarget();

  readonly #db: ClientDb;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #debounceMs: number;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timers: Timers;
  readonly #isOnline: () => boolean;
  readonly #timeoutMs: number;

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
    this.#timeoutMs = options.timeoutMs ?? 30_000;
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
        const run: RunState = { dirty: false };
        try {
          await this.#push(run);
          await this.#pull(run);
          // The pull has the changes of the acked ops now.
          if ((await this.#db.outbox.filter((e) => !!e.acked).delete()) > 0) {
            run.dirty = true;
          }
        } finally {
          // Also after an error: a rejected op must leave the view. An acked
          // op stays in the outbox, thus the view keeps it. No change on
          // either side: the view is already right.
          if (run.dirty) await rebuildView(this.#db);
        }
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

  /**
   * A request, and its body as JSON. A timeout (`timeoutMs`) is a network
   * error: the run fails and the engine tries again with backoff. The
   * timeout also covers the body, thus a hung stream does not keep the lock.
   */
  async #request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: T | null }> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(this.#timeoutMs),
      ...init,
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, body: null };
    }
    return { status: res.status, body: (await res.json()) as T };
  }

  /** Drop outbox entries, and send a "rejected" event for each. */
  async #drop(
    run: RunState,
    entries: OutboxEntry[],
    reason: RejectedDetail["reason"],
  ) {
    await this.#db.outbox.bulkDelete(entries.map((e) => e.seq!));
    run.dirty = true;
    for (const e of entries) this.#reject(e.op, reason);
  }

  /**
   * Push the outbox. A 413, or a 400 with no op that fails the local
   * schema, makes the next batch half as large. A batch of one op that gets
   * such an error drops the op as "invalid". Thus one bad op does not stop
   * the ops after it.
   */
  async #push(run: RunState): Promise<void> {
    const db = this.#db;
    const clientId = await ensureClientId(db);
    let size = MAX_PUSH_OPS;
    for (let round = 0; round < MAX_PUSHES; round++) {
      const entries = await db.outbox
        .orderBy("seq")
        .filter((e) => !e.acked)
        .limit(size)
        .toArray();
      if (entries.length === 0) return;

      const res = await this.#request<PushResponse>("/api/sync/push", {
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
        if (bad.length > 0) {
          await this.#drop(run, bad, "invalid");
          continue;
        }
      }
      if (res.status === 400 || res.status === 413) {
        if (entries.length === 1) {
          await this.#drop(run, entries, "invalid");
          size = MAX_PUSH_OPS;
        } else {
          size = Math.ceil(entries.length / 2);
        }
        continue;
      }
      if (!res.body) throw new HttpError(res.status);

      const body = res.body;
      const restamp: number[] = [];
      const done: number[] = [];
      const acked: number[] = [];
      entries.forEach((entry, i) => {
        const result = body.results[i];
        const final = result?.status === "duplicate" ? result.original : result;
        // The device clock is too far ahead. Stamp the op again one time
        // with the server time, and do not lose the edit.
        if (
          final?.status === "rejected" &&
          final.reason === "clock_ahead" &&
          !entry.restamped
        ) {
          restamp.push(entry.seq!);
          return;
        }
        // An applied op stays until the pull. A rejected op goes. A merged
        // op goes too: the server kept a different item.
        if (final?.status === "applied") acked.push(entry.seq!);
        else done.push(entry.seq!);
        if (final?.status === "rejected") this.#reject(entry.op, final.reason);
        // Only a new result: a duplicate was shown the first time.
        if (result?.status === "merged") {
          this.events.dispatchEvent(
            new CustomEvent<MergedDetail>("merged", {
              detail: {
                op: entry.op,
                into: result.into,
                changed: result.changed,
              },
            }),
          );
        }
      });
      await db.outbox.bulkDelete(done);
      await db.outbox.bulkUpdate(
        acked.map((seq) => ({ key: seq, changes: { acked: true } })),
      );
      if (restamp.length > 0) {
        await restampOps(db, restamp, body.now ?? Date.now());
      }
      run.dirty = true;
    }
  }

  /** Pull every page. */
  async #pull(run: RunState): Promise<void> {
    let cursor = (await getMeta(this.#db, "cursor")) ?? 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      // `seen` changes at each page: a reset page sends the new purgedSeq.
      const seen = await getMeta(this.#db, "purgedSeq");
      const query = new URLSearchParams({ since: String(cursor) });
      if (seen !== undefined) query.set("seen", String(seen));
      const res = await this.#request<PullResponse>(`/api/sync/pull?${query}`);
      if (!res.body) throw new HttpError(res.status);
      const body = res.body;
      await savePullPage(this.#db, body);
      if (body.reset || body.lists.length > 0 || body.items.length > 0) {
        run.dirty = true;
      }
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
