// Push wire formats (#15). This file imports only zod.
import { z } from "zod";

/** What the service worker shows. */
export interface PushPayload {
  title: string;
  body: string;
  /** A same-origin path to open on a tap, for example /lists/<id>. */
  url: string;
  /** One notification for each tag: a new one replaces the old one. */
  tag?: string;
}

export interface SubscriptionInfo {
  id: string;
  endpoint: string;
  deviceLabel: string | null;
  enabled: boolean;
  createdAt: number;
  lastSuccessAt: number | null;
}

/** POST /api/push/subscriptions: the PushSubscription JSON and a label. */
export const subscribeSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
  deviceLabel: z.string().trim().max(60).nullable().default(null),
});

/** PATCH /api/push/subscriptions/<id>. */
export const updateSubscriptionSchema = z.strictObject({
  enabled: z.boolean(),
});

/** PUT /api/push/mutes: mute or unmute one list. */
export const muteSchema = z.strictObject({
  listId: z.uuid(),
  muted: z.boolean(),
});
