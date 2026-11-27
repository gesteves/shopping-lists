// Web Push (#15): subscriptions, list mutes, and sending. The notifier (#16)
// sends through sendToUser().
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { sendNotification } from "web-push";
import { getDb, type Db } from "@/db/client";
import { listMutes, pushSubscriptions } from "@/db/schema";
import type { PushPayload, SubscriptionInfo } from "@/shared/push";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** An https URL or a mailto: address. The app URL by default. */
  subject: string;
}

/**
 * The VAPID keys from the env, or null if push is not set up. Make keys with
 * `npx web-push generate-vapid-keys`.
 */
export function getVapidConfig(
  env: NodeJS.ProcessEnv = process.env,
): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject =
    env.VAPID_SUBJECT ||
    (env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).origin : undefined);
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

type SubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * A device whose pushes fail for this long, with no success, is turned off
 * (#118). For example, a 403 after a change of the VAPID keys.
 */
export const FAILING_DISABLE_MS = 7 * 24 * 60 * 60_000;

/** The failures that stop: the server turned the device off. */
function failedTooLong(row: {
  failingSince: Date | null;
  lastFailureAt: Date | null;
}): boolean {
  if (!row.failingSince || !row.lastFailureAt) return false;
  return (
    row.lastFailureAt.getTime() - row.failingSince.getTime() >=
    FAILING_DISABLE_MS
  );
}

function toInfo(row: SubscriptionRow): SubscriptionInfo {
  return {
    id: row.id,
    endpoint: row.endpoint,
    deviceLabel: row.deviceLabel,
    enabled: row.enabled,
    createdAt: row.createdAt.getTime(),
    lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
    notDelivering: !row.enabled && failedTooLong(row),
  };
}

/** No failures: a new start for the device. */
const NO_FAILURES = {
  failureCount: 0,
  failingSince: null,
  lastFailureAt: null,
} as const;

/**
 * Save a browser subscription for a user. The endpoint is unique: a browser
 * that subscribes again replaces its row. An endpoint of a different user
 * does not move to the caller: it gives null.
 */
export function saveSubscription(
  userId: string,
  input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    deviceLabel: string | null;
  },
  db: Db = getDb(),
): SubscriptionInfo | null {
  const row = db
    .insert(pushSubscriptions)
    .values({
      id: crypto.randomUUID(),
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      deviceLabel: input.deviceLabel,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        deviceLabel: input.deviceLabel,
        enabled: true,
        ...NO_FAILURES,
      },
      where: eq(pushSubscriptions.userId, userId),
    })
    .returning()
    .get();
  return row ? toInfo(row) : null;
}

export function listSubscriptions(
  userId: string,
  db: Db = getDb(),
): SubscriptionInfo[] {
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(pushSubscriptions.createdAt)
    .all()
    .map(toInfo);
}

/**
 * Turn a device on or off. False if the user has no such device. On clears
 * the failures, thus a device that was not delivering gets a new try.
 */
export function setSubscriptionEnabled(
  userId: string,
  id: string,
  enabled: boolean,
  db: Db = getDb(),
): boolean {
  const result = db
    .update(pushSubscriptions)
    .set(enabled ? { enabled, ...NO_FAILURES } : { enabled })
    .where(
      and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)),
    )
    .run();
  return result.changes > 0;
}

export function removeSubscription(
  userId: string,
  id: string,
  db: Db = getDb(),
): boolean {
  const result = db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)),
    )
    .run();
  return result.changes > 0;
}

/** The IDs of the lists that the user muted. */
export function listMutedListIds(userId: string, db: Db = getDb()): string[] {
  return db
    .select({ listId: listMutes.listId })
    .from(listMutes)
    .where(eq(listMutes.userId, userId))
    .all()
    .map((r) => r.listId);
}

export function setListMuted(
  userId: string,
  listId: string,
  muted: boolean,
  db: Db = getDb(),
): void {
  if (muted) {
    db.insert(listMutes).values({ userId, listId }).onConflictDoNothing().run();
  } else {
    db.delete(listMutes)
      .where(and(eq(listMutes.userId, userId), eq(listMutes.listId, listId)))
      .run();
  }
}

/** The longest wait for a push service. */
export const PUSH_TIMEOUT_MS = 10_000;

/** On a 429, try one more time if `Retry-After` is at most this. */
export const MAX_RETRY_AFTER_MS = 5_000;

export interface SendResult {
  sent: number;
  /** Subscriptions that the push service no longer knows, now deleted. */
  removed: number;
  failed: number;
}

export interface SendOptions {
  db?: Db;
  vapid?: VapidConfig | null;
  /** For tests. */
  send?: typeof sendNotification;
  /** For tests. */
  now?: () => number;
  /** For tests: the wait before the retry of a 429. */
  wait?: (ms: number) => Promise<void>;
  /** Only these subscription IDs. */
  only?: string[];
}

/**
 * True if a push to the user can go out: the VAPID keys are set, and the
 * user has an enabled device. The notifier calls Claude only then (#118).
 */
export function canPushTo(
  userId: string,
  options: Pick<SendOptions, "db" | "vapid"> = {},
): boolean {
  const db = options.db ?? getDb();
  const vapid = options.vapid === undefined ? getVapidConfig() : options.vapid;
  if (!vapid) return false;
  const row = db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.enabled, true),
      ),
    )
    .get();
  return row !== undefined;
}

interface PushError {
  statusCode?: number;
  headers?: Record<string, string | undefined>;
}

/** The wait of a `Retry-After` header (seconds or a date), or null. */
export function retryAfterMs(
  error: PushError,
  now: number = Date.now(),
): number | null {
  const value = error.headers?.["retry-after"]?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send a push to each enabled device of a user. A 404 or 410 from the push
 * service deletes the subscription. A 429 with a short `Retry-After` gets
 * one more try. A success sets last_success_at and clears the failures. A
 * failure adds one to the count. A device that fails for
 * FAILING_DISABLE_MS with no success is turned off (#118).
 */
export async function sendToUser(
  userId: string,
  payload: PushPayload,
  options: SendOptions = {},
): Promise<SendResult> {
  const db = options.db ?? getDb();
  const vapid = options.vapid === undefined ? getVapidConfig() : options.vapid;
  const send = options.send ?? sendNotification;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  if (!vapid) return result;

  const conditions = [
    eq(pushSubscriptions.userId, userId),
    eq(pushSubscriptions.enabled, true),
  ];
  if (options.only)
    conditions.push(inArray(pushSubscriptions.id, options.only));
  const rows = db
    .select()
    .from(pushSubscriptions)
    .where(and(...conditions))
    .all();

  const body = JSON.stringify(payload);
  await Promise.all(
    rows.map(async (row) => {
      const push = () =>
        send(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          body,
          {
            vapidDetails: vapid,
            // A shopping change is useless after a day.
            TTL: 24 * 60 * 60,
            urgency: "normal",
            // A push service that does not answer must not stop the
            // notifier.
            timeout: PUSH_TIMEOUT_MS,
            topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
          },
        );
      try {
        try {
          await push();
        } catch (error) {
          const delay =
            (error as PushError).statusCode === 429
              ? retryAfterMs(error as PushError, now())
              : null;
          if (delay === null || delay > MAX_RETRY_AFTER_MS) throw error;
          await wait(delay);
          await push();
        }
        db.update(pushSubscriptions)
          .set({ lastSuccessAt: new Date(now()), ...NO_FAILURES })
          .where(eq(pushSubscriptions.id, row.id))
          .run();
        result.sent++;
      } catch (error) {
        const status = (error as PushError).statusCode;
        if (status === 404 || status === 410) {
          db.delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, row.id))
            .run();
          result.removed++;
          return;
        }
        console.error("Push failed", status ?? error);
        result.failed++;
        recordFailure(db, row, new Date(now()));
      }
    }),
  );
  return result;
}

/** Add one failure. Turn the device off if it failed for too long. */
function recordFailure(db: Db, row: SubscriptionRow, at: Date) {
  const failingSince = row.failingSince ?? at;
  const stop = failedTooLong({ failingSince, lastFailureAt: at });
  db.update(pushSubscriptions)
    .set({
      failureCount: sql`${pushSubscriptions.failureCount} + 1`,
      failingSince,
      lastFailureAt: at,
      ...(stop && { enabled: false }),
    })
    .where(eq(pushSubscriptions.id, row.id))
    .run();
  if (stop) console.warn("Push device turned off: no delivery for 7 days");
}
