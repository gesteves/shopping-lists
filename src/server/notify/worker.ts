// The notifier (#16): an interval in the server process. It groups the
// activity rows that were not sent by person, waits for a quiet time, then
// sends one push to each other person. See "Notifications" in docs/PLAN.md.
import "server-only";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { copy } from "@/copy";
import { getDb, type Db } from "@/db/client";
import { activity, listMutes, users } from "@/db/schema";
import type { PushPayload } from "@/shared/push";
import { sendToUser } from "../push";
import { collapse } from "./collapse";
import { renderEvent, renderFallback } from "./templates";
import type { ActivityEvent } from "./types";

export interface NotifierOptions {
  db?: Db;
  now?: () => number;
  /** Wait this long after the last change of a person. */
  quietMs?: number;
  /** Send at most this long after the first change of a burst. */
  maxWaitMs?: number;
  /** Sends a push to the devices of a user. */
  send?: (userId: string, payload: PushPayload) => Promise<unknown>;
  /**
   * The text for more than one event. #17 gives a Claude summary. The
   * default is the fixed fallback.
   */
  summarize?: (events: ActivityEvent[], actorName: string) => Promise<string>;
}

export const TICK_MS = 10_000;
export const QUIET_MS = 60_000;
export const MAX_WAIT_MS = 3 * 60_000;

/** The push for the events that are left after collapse, or null. */
export async function buildPayload(
  events: ActivityEvent[],
  actorName: string,
  summarize: NonNullable<NotifierOptions["summarize"]>,
): Promise<PushPayload | null> {
  if (events.length === 0) return null;
  const listIds = [...new Set(events.map((e) => e.listId))];
  const oneList = listIds.length === 1;
  const body =
    events.length === 1
      ? renderEvent(events[0], actorName)
      : await summarize(events, actorName);
  const deleted = events.some(
    (e) => e.type === "deleteList" && e.listId === listIds[0],
  );
  return {
    title: oneList ? events.at(-1)!.snapshot.listName : copy.push.title,
    body,
    url: oneList && !deleted ? `/lists/${listIds[0]}` : "/",
    // One notification for each list: a new burst replaces the last one.
    tag: oneList ? listIds[0] : "activity",
  };
}

export class Notifier {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #quietMs: number;
  readonly #maxWaitMs: number;
  readonly #send: NonNullable<NotifierOptions["send"]>;
  readonly #summarize: NonNullable<NotifierOptions["summarize"]>;
  #running = false;

  constructor(options: NotifierOptions = {}) {
    this.#db = options.db ?? getDb();
    this.#now = options.now ?? Date.now;
    this.#quietMs = options.quietMs ?? QUIET_MS;
    this.#maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.#send =
      options.send ?? ((userId, payload) => sendToUser(userId, payload));
    this.#summarize =
      options.summarize ??
      (async (events, name) => renderFallback(events, name));
  }

  /** One pass: send each group that is ready. Not reentrant. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const group of this.#readyGroups()) await this.#flush(group);
    } finally {
      this.#running = false;
    }
  }

  #readyGroups(): ActivityEvent[][] {
    const rows = this.#db
      .select()
      .from(activity)
      .where(isNull(activity.notifiedAt))
      .orderBy(activity.id)
      .all();
    const groups = new Map<string, ActivityEvent[]>();
    for (const row of rows) {
      // One group for each person and channel: "(via Claude)" is for all
      // of the text.
      const key = `${row.actorId}:${row.via}`;
      const group = groups.get(key) ?? [];
      group.push({
        id: row.id,
        actorId: row.actorId,
        via: row.via,
        type: row.type,
        listId: row.listId,
        itemId: row.itemId,
        snapshot: row.snapshot,
        at: row.at.getTime(),
      });
      groups.set(key, group);
    }
    const now = this.#now();
    return [...groups.values()].filter(
      (g) =>
        now - g.at(-1)!.at >= this.#quietMs || now - g[0].at >= this.#maxWaitMs,
    );
  }

  async #flush(group: ActivityEvent[]): Promise<void> {
    const db = this.#db;
    const actorId = group[0].actorId;
    const ids = group.map((e) => e.id);

    // Mark the rows first. A crash after this loses one push; it never
    // sends the same push two times.
    db.update(activity)
      .set({ notifiedAt: new Date(this.#now()) })
      .where(and(inArray(activity.id, ids), isNull(activity.notifiedAt)))
      .run();

    const actor = db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, actorId))
      .get();
    const recipients = db
      .select({ id: users.id })
      .from(users)
      .where(ne(users.id, actorId))
      .all();

    for (const recipient of recipients) {
      const muted = new Set(
        db
          .select({ listId: listMutes.listId })
          .from(listMutes)
          .where(eq(listMutes.userId, recipient.id))
          .all()
          .map((m) => m.listId),
      );
      const events = collapse(group.filter((e) => !muted.has(e.listId)));
      try {
        const payload = await buildPayload(
          events,
          actor?.name ?? copy.people.someone,
          this.#summarize,
        );
        if (payload) await this.#send(recipient.id, payload);
      } catch (error) {
        console.error("Notification failed", error);
      }
    }
  }
}

/**
 * Start the notifier in this process, one time. The server calls it at boot
 * (src/instrumentation.ts).
 */
export function startNotifier(options: NotifierOptions = {}): Notifier {
  const KEY = Symbol.for("shopping-lists.notifier");
  const store = globalThis as typeof globalThis & { [KEY]?: Notifier };
  if (store[KEY]) return store[KEY];
  const notifier = new Notifier(options);
  setInterval(() => void notifier.tick(), TICK_MS).unref();
  store[KEY] = notifier;
  return notifier;
}
