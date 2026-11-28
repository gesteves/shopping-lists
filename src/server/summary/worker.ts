// The summary worker: an interval in the server process. When the unchecked
// items of a list change, it waits for a quiet time, then asks Claude for a
// new summary of the list. See "List summaries" in docs/PLAN.md.
import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { items, lists } from "@/db/schema";
import {
  SUMMARY_MIN_ITEMS,
  summaryKeyText,
  type SummaryItem,
} from "@/shared/summary";
import { log } from "../log";
import { setListSummary } from "../ops";
import type { ListSummarizer } from "./summarize";

export const TICK_MS = 10_000;
const WORKER_KEY = "shopping-lists.summary-worker";
/**
 * Wait this long after the last change of the items, by default. The env
 * var SUMMARY_QUIET_SECONDS changes it (quietMsFromEnv).
 */
export const QUIET_MS = 15_000;
/** Make a summary at most this long after the first change. */
export const MAX_WAIT_MS = 3 * 60_000;
/** After a failure, wait this long before a new try for the same items. */
export const RETRY_MS = 10 * 60_000;

/**
 * The same items, in any order, give the same key. The client makes the
 * same key with summaryKeyOf (src/shared/summary.ts, #143).
 */
export function summaryKey(summaryItems: SummaryItem[]): string {
  return createHash("sha256")
    .update(summaryKeyText(summaryItems))
    .digest("base64url");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** True if this process runs the summary worker (#143). */
export function summaryWorkerRunning(): boolean {
  const KEY = Symbol.for(WORKER_KEY);
  return !!(globalThis as Record<symbol, unknown>)[KEY];
}

export interface SummaryWorkerOptions {
  db?: Db;
  now?: () => number;
  summarize: ListSummarizer;
  /** The quiet time. Default: QUIET_MS. */
  quietMs?: number;
}

/**
 * The quiet time from SUMMARY_QUIET_SECONDS: a number of seconds, 0 or
 * more. Empty or not set gives QUIET_MS. A bad value gives QUIET_MS and a
 * warning. MAX_WAIT_MS stays the limit, thus a long value waits at most
 * that long.
 */
export function quietMsFromEnv(
  value = process.env.SUMMARY_QUIET_SECONDS,
): number {
  if (value === undefined || value.trim() === "") return QUIET_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    log.warn("boot", "bad SUMMARY_QUIET_SECONDS", { quiet: QUIET_MS / 1000 });
    return QUIET_MS;
  }
  return Math.round(seconds * 1000);
}

interface Pending {
  key: string;
  /** The last time that the key changed. */
  since: number;
  /** The first time that the key was different from the stored key. */
  first: number;
}

export class SummaryWorker {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #summarize: ListSummarizer;
  readonly #quietMs: number;
  readonly #pending = new Map<string, Pending>();
  readonly #failed = new Map<string, { key: string; until: number }>();
  #running = false;

  constructor(options: SummaryWorkerOptions) {
    this.#db = options.db ?? getDb();
    this.#now = options.now ?? Date.now;
    this.#summarize = options.summarize;
    this.#quietMs = options.quietMs ?? QUIET_MS;
  }

  /**
   * One pass: make each summary that is ready. Not reentrant. It does not
   * throw: an error goes to the log, and the next tick tries again.
   */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const list of this.#ready()) {
        const started = this.#now();
        const summary = await this.#summarize(list.name, list.items);
        this.#pending.delete(list.id);
        // The time from the first change of the items to the write: the
        // wait for a quiet time, then the request. IDs only, no names.
        const ms = this.#now() - started;
        log.info("summary", "done", {
          list: list.id,
          items: list.items.length,
          ready: list.reason,
          wait: seconds(list.waited),
          claude: seconds(ms),
          total: seconds(list.waited + ms),
          result: summary ? "written" : "failed",
        });
        if (summary) {
          this.#failed.delete(list.id);
          setListSummary(list.id, summary, list.key, { db: this.#db });
        } else {
          this.#failed.set(list.id, {
            key: list.key,
            until: this.#now() + RETRY_MS,
          });
        }
      }
    } catch (error) {
      log.error("summary", "tick failed", {}, error);
    } finally {
      this.#running = false;
    }
  }

  /** The lists whose items changed and then were quiet. */
  #ready() {
    const db = this.#db;
    const now = this.#now();
    const live = db
      .select({ id: lists.id, name: lists.name, key: lists.summaryKey })
      .from(lists)
      .where(isNull(lists.deletedAt))
      .all();
    const rows = db
      .select({
        listId: items.listId,
        name: items.name,
        quantity: items.quantity,
      })
      .from(items)
      .where(and(isNull(items.deletedAt), eq(items.checked, false)))
      .orderBy(items.nameKey)
      .all();
    const byList = new Map<string, SummaryItem[]>();
    for (const { listId, ...item } of rows) {
      byList.set(listId, [...(byList.get(listId) ?? []), item]);
    }

    const ready: {
      id: string;
      name: string;
      key: string;
      items: SummaryItem[];
      /** Why it is ready: a quiet time, the longest wait, or a retry. */
      reason: "quiet" | "max" | "retry";
      /** The time since the first change of the items. */
      waited: number;
    }[] = [];
    const ids = new Set(live.map((l) => l.id));
    for (const id of this.#pending.keys()) {
      if (!ids.has(id)) this.#pending.delete(id);
    }
    for (const id of this.#failed.keys()) {
      if (!ids.has(id)) this.#failed.delete(id);
    }

    for (const list of live) {
      const listItems = byList.get(list.id) ?? [];
      // A list with one item shows its name. Its old summary stays for later.
      const key =
        listItems.length < SUMMARY_MIN_ITEMS ? null : summaryKey(listItems);
      if (key === null || key === list.key) {
        this.#pending.delete(list.id);
        continue;
      }
      const failed = this.#failed.get(list.id);
      if (failed?.key === key) {
        // The same items failed before: try again after RETRY_MS, with no
        // new quiet time.
        if (now >= failed.until) {
          ready.push({
            id: list.id,
            name: list.name,
            key,
            items: listItems,
            reason: "retry",
            waited: now - (failed.until - RETRY_MS),
          });
        }
        continue;
      }

      const pending = this.#pending.get(list.id);
      if (!pending) {
        this.#pending.set(list.id, { key, since: now, first: now });
        log.debug("summary", "waiting", { list: list.id });
        continue;
      }
      if (pending.key !== key) {
        pending.key = key;
        pending.since = now;
      }
      const quiet = now - pending.since >= this.#quietMs;
      if (quiet || now - pending.first >= MAX_WAIT_MS) {
        ready.push({
          id: list.id,
          name: list.name,
          key,
          items: listItems,
          reason: quiet ? "quiet" : "max",
          waited: now - pending.first,
        });
      }
    }
    return ready;
  }
}

/**
 * Start the summary worker in this process, one time. The server calls it
 * at boot (src/instrumentation.ts), only with ANTHROPIC_API_KEY.
 */
export function startSummaryWorker(
  options: SummaryWorkerOptions,
): SummaryWorker {
  const KEY = Symbol.for(WORKER_KEY);
  const store = globalThis as typeof globalThis & { [KEY]?: SummaryWorker };
  if (store[KEY]) return store[KEY];
  const quietMs = options.quietMs ?? quietMsFromEnv();
  const worker = new SummaryWorker({ ...options, quietMs });
  log.info("summary", "started", { quiet: quietMs / 1000 });
  setInterval(() => void worker.tick(), TICK_MS).unref();
  store[KEY] = worker;
  return worker;
}
