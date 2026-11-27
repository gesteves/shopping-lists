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
  /**
   * The server turned the device off: its pushes failed for
   * `FAILING_DISABLE_MS` with no success (#118).
   */
  notDelivering: boolean;
}

/**
 * The hosts of the browser push services: Chrome and other Chromium browsers
 * (FCM), Firefox, Safari, and Edge. A subdomain also matches.
 */
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

/**
 * True if the endpoint is on a known push service. The server sends a
 * request to each endpoint, thus it must not go to any other host.
 * `allowLoopback` is for the e2e tests only.
 */
export function isPushEndpoint(
  endpoint: string,
  options: { allowLoopback?: boolean } = {},
): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (options.allowLoopback && host === "127.0.0.1") return true;
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * POST /api/push/subscriptions: the PushSubscription JSON
 * (`PushSubscription.toJSON()`) and a label.
 */
export function subscribeSchema(options: { allowLoopback?: boolean } = {}) {
  return z.strictObject({
    endpoint: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .refine((url) => isPushEndpoint(url, options), {
        message: "Not a known push service",
      }),
    expirationTime: z.number().nullable().optional(),
    keys: z.strictObject({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(100),
    }),
    deviceLabel: z.string().trim().max(60).nullable().default(null),
  });
}

/** POST /api/push/test: an empty object. */
export const testPushSchema = z.strictObject({});

/** PATCH /api/push/subscriptions/<id>. */
export const updateSubscriptionSchema = z.strictObject({
  enabled: z.boolean(),
});

/** PUT /api/push/mutes: mute or unmute one list. */
export const muteSchema = z.strictObject({
  listId: z.uuid(),
  muted: z.boolean(),
});
