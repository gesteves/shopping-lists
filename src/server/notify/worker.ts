// The notifier (#16): an interval in the server process. It groups the
// activity rows that were not sent by person and `via`, waits for a quiet
// time, then sends one push to each other person. See "Notifications" in
// docs/PLAN.md.
import "server-only";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { copy } from "@/copy";
import { getDb, type Db } from "@/db/client";
import { activity, listMutes, lists, users } from "@/db/schema";
import { isAllowedEmail } from "@/lib/allowlist";
import type { PushPayload } from "@/shared/push";
import { log } from "../log";
import { canPushTo, sendToUser } from "../push";
import { collapse } from "./collapse";
import { renderFallback } from "./templates";
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
   * True if a push to the user can go out (VAPID keys and an enabled
   * device). If not, the notifier makes no text, thus no Claude call.
   */
  canPush?: (userId: string) => boolean;
  /**
   * The text for the events. #17 and #89 give a Claude summary. The default
   * is the fixed fallback.
   */
  summarize?: (events: ActivityEvent[], actorName: string) => Promise<string>;
  /** `ALLOWED_EMAILS`. Only these users get pushes. */
  allowlist?: string;
}

/** The most IDs in one `inArray` (SQLite limits the variables). */
const ID_CHUNK = 500;

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
  // Claude writes each body, also for one event (#89): it writes item names
  // in lowercase, as in a sentence. Without Claude, the fallback is a
  // template.
  const body = await summarize(events, actorName);
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

/**
 * The rows that the notifier did not send. With no ORDER BY, SQLite reads
 * them through activity_pending_idx, and not the sent rows.
 */
export function pendingActivity(db: Db) {
  return db.select().from(activity).where(isNull(activity.notifiedAt));
}

export class Notifier {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #quietMs: number;
  readonly #maxWaitMs: number;
  readonly #send: NonNullable<NotifierOptions["send"]>;
  readonly #canPush: NonNullable<NotifierOptions["canPush"]>;
  readonly #summarize: NonNullable<NotifierOptions["summarize"]>;
  readonly #allowlist: () => string | undefined;
  #running = false;

  constructor(options: NotifierOptions = {}) {
    this.#db = options.db ?? getDb();
    this.#now = options.now ?? Date.now;
    this.#quietMs = options.quietMs ?? QUIET_MS;
    this.#maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.#send =
      options.send ?? ((userId, payload) => sendToUser(userId, payload));
    this.#canPush =
      options.canPush ?? ((userId) => canPushTo(userId, { db: this.#db }));
    this.#summarize =
      options.summarize ??
      (async (events, name) => renderFallback(events, name));
    const allowlist = options.allowlist;
    this.#allowlist = () => allowlist ?? process.env.ALLOWED_EMAILS;
  }

  /**
   * One pass: send each group that is ready. Not reentrant. It does not
   * throw: an error goes to the log, and the next tick tries again.
   */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const group of this.#readyGroups()) await this.#flush(group);
    } catch (error) {
      log.error("notify", "tick failed", {}, error);
    } finally {
      this.#running = false;
    }
  }

  #readyGroups(): ActivityEvent[][] {
    // Sort in JS: with ORDER BY id, SQLite scans the whole table and not
    // activity_pending_idx (#118).
    const rows = pendingActivity(this.#db)
      .all()
      .sort((a, b) => a.id - b.id);
    const groups = new Map<string, ActivityEvent[]>();
    for (const row of rows) {
      // A change of the server itself has notified_at set at insert, thus
      // it is not here. This check is for the types (#152).
      if (row.actorId === null || row.via === "system") continue;
      if (row.type === "expireItem") continue;
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

  async #flush(rows: ActivityEvent[]): Promise<void> {
    let group = rows;
    const db = this.#db;
    const actorId = group[0].actorId;
    const ids = group.map((e) => e.id);
    // IDs and counts only: no names.
    const burst = {
      actor: actorId,
      via: group[0].via,
      events: rows.length,
      lists: new Set(rows.map((e) => e.listId)).size,
      ready:
        this.#now() - rows.at(-1)!.at >= this.#quietMs
          ? ("quiet" as const)
          : ("max" as const),
    };

    // Mark the rows first. A crash after this loses one push; it never
    // sends the same push two times.
    const at = new Date(this.#now());
    db.transaction((tx) => {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        tx.update(activity)
          .set({ notifiedAt: at })
          .where(
            and(
              inArray(activity.id, ids.slice(i, i + ID_CHUNK)),
              isNull(activity.notifiedAt),
            ),
          )
          .run();
      }
    });

    // A private list sends no push (#154). The rows on a private list have
    // notified_at set at insert. These are the rows from before the list
    // became private.
    const privateLists = new Set(
      db
        .select({ id: lists.id })
        .from(lists)
        .where(
          and(
            eq(lists.private, true),
            inArray(lists.id, [...new Set(group.map((e) => e.listId))]),
          ),
        )
        .all()
        .map((l) => l.id),
    );
    group = group.filter((e) => !privateLists.has(e.listId));
    if (group.length === 0) {
      log.debug("notify", "skipped", { ...burst, reason: "private" });
      return;
    }

    const actor = db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, actorId))
      .get();
    // A user who is no longer in ALLOWED_EMAILS gets nothing.
    const allowlist = this.#allowlist();
    const recipients = db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(ne(users.id, actorId))
      .all()
      .filter((user) => isAllowedEmail(user.email, allowlist));

    let sent = 0;
    for (const recipient of recipients) {
      // No push can go out: make no text, thus no Claude call.
      if (!this.#canPush(recipient.id)) {
        log.debug("notify", "skipped", {
          ...burst,
          user: recipient.id,
          reason: "no_device",
        });
        continue;
      }
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
        if (payload) {
          await this.#send(recipient.id, payload);
          sent++;
        } else {
          log.debug("notify", "skipped", {
            ...burst,
            user: recipient.id,
            reason: "muted",
          });
        }
      } catch (error) {
        log.error(
          "notify",
          "send failed",
          { ...burst, user: recipient.id },
          error,
        );
      }
    }
    log.info("notify", "burst", {
      ...burst,
      recipients: recipients.length,
      sent,
    });
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
  log.info("notify", "started");
  setInterval(() => void notifier.tick(), TICK_MS).unref();
  store[KEY] = notifier;
  return notifier;
}
