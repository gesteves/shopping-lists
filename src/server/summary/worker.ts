// The summary worker: an interval in the server process. When the unchecked
// items of a list change, it waits for a quiet time, then asks Claude for a
// new summary of the list. See "List summaries" in docs/PLAN.md.
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { items, lists } from "@/db/schema";
import { SUMMARY_MIN_ITEMS, summaryKey } from "@/shared/summary";
import { setListSummary } from "../ops";
import type { ListSummarizer, SummaryItem } from "./summarize";

export const TICK_MS = 10_000;
/** Wait this long after the last change of the items. */
export const QUIET_MS = 60_000;
/** Make a summary at most this long after the first change. */
export const MAX_WAIT_MS = 3 * 60_000;
/** After a failure, wait this long before a new try for the same items. */
export const RETRY_MS = 10 * 60_000;

export interface SummaryWorkerOptions {
  db?: Db;
  now?: () => number;
  summarize: ListSummarizer;
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
  readonly #pending = new Map<string, Pending>();
  readonly #failed = new Map<string, { key: string; until: number }>();
  #running = false;

  constructor(options: SummaryWorkerOptions) {
    this.#db = options.db ?? getDb();
    this.#now = options.now ?? Date.now;
    this.#summarize = options.summarize;
  }

  /** One pass: make each summary that is ready. Not reentrant. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const list of this.#ready()) {
        const summary = await this.#summarize(list.name, list.items);
        this.#pending.delete(list.id);
        // A failure saves no summary for the key, thus the page stops the
        // sparkles and shows the count (#91).
        setListSummary(list.id, summary, list.key, { db: this.#db });
        if (summary) {
          this.#failed.delete(list.id);
        } else {
          this.#failed.set(list.id, {
            key: list.key,
            until: this.#now() + RETRY_MS,
          });
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** The lists whose items changed and then were quiet. */
  #ready() {
    const db = this.#db;
    const now = this.#now();
    const live = db
      .select({
        id: lists.id,
        name: lists.name,
        key: lists.summaryKey,
        summary: lists.summary,
      })
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
      if (key === null || (key === list.key && list.summary !== null)) {
        this.#pending.delete(list.id);
        continue;
      }
      if (key === list.key) {
        // The same items failed before: try again after RETRY_MS, with no
        // new quiet time. After a restart, try at once.
        const failed = this.#failed.get(list.id);
        if (failed?.key !== key || now >= failed.until) {
          ready.push({ id: list.id, name: list.name, key, items: listItems });
        }
        continue;
      }

      const pending = this.#pending.get(list.id);
      if (!pending) {
        this.#pending.set(list.id, { key, since: now, first: now });
        continue;
      }
      if (pending.key !== key) {
        pending.key = key;
        pending.since = now;
      }
      if (
        now - pending.since >= QUIET_MS ||
        now - pending.first >= MAX_WAIT_MS
      ) {
        ready.push({ id: list.id, name: list.name, key, items: listItems });
      }
    }
    return ready;
  }
}

const KEY = Symbol.for("shopping-lists.summary-worker");
type Store = typeof globalThis & { [KEY]?: SummaryWorker };

/** True if the summary worker runs in this process. */
export function summaryWorkerRunning(): boolean {
  return (globalThis as Store)[KEY] !== undefined;
}

/**
 * Start the summary worker in this process, one time. The server calls it
 * at boot (src/instrumentation.ts), only with ANTHROPIC_API_KEY.
 */
export function startSummaryWorker(
  options: SummaryWorkerOptions,
): SummaryWorker {
  const store = globalThis as Store;
  if (store[KEY]) return store[KEY];
  const worker = new SummaryWorker(options);
  setInterval(() => void worker.tick(), TICK_MS).unref();
  store[KEY] = worker;
  return worker;
}
