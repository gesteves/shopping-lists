// Web Push (#15): subscriptions, list mutes, and sending. The notifier (#16)
// sends through sendToUser().
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
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

function toInfo(row: SubscriptionRow): SubscriptionInfo {
  return {
    id: row.id,
    endpoint: row.endpoint,
    deviceLabel: row.deviceLabel,
    enabled: row.enabled,
    createdAt: row.createdAt.getTime(),
    lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
  };
}

/**
 * Save a browser subscription for a user. The endpoint is unique: a browser
 * that subscribes again (or for a different user) replaces its row.
 */
export function saveSubscription(
  userId: string,
  input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    deviceLabel: string | null;
  },
  db: Db = getDb(),
): SubscriptionInfo {
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
      },
    })
    .returning()
    .get();
  return toInfo(row);
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

/** Turn a device on or off. False if the user has no such device. */
export function setSubscriptionEnabled(
  userId: string,
  id: string,
  enabled: boolean,
  db: Db = getDb(),
): boolean {
  const result = db
    .update(pushSubscriptions)
    .set({ enabled })
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
  /** Only these subscription IDs. */
  only?: string[];
}

/**
 * Send a push to each enabled device of a user. A 404 or 410 from the push
 * service deletes the subscription. A success sets last_success_at.
 */
export async function sendToUser(
  userId: string,
  payload: PushPayload,
  options: SendOptions = {},
): Promise<SendResult> {
  const db = options.db ?? getDb();
  const vapid = options.vapid === undefined ? getVapidConfig() : options.vapid;
  const send = options.send ?? sendNotification;
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
      try {
        await send(
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
            topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
          },
        );
        db.update(pushSubscriptions)
          .set({ lastSuccessAt: new Date() })
          .where(eq(pushSubscriptions.id, row.id))
          .run();
        result.sent++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          db.delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, row.id))
            .run();
          result.removed++;
        } else {
          console.error("Push failed", status ?? error);
          result.failed++;
        }
      }
    }),
  );
  return result;
}
