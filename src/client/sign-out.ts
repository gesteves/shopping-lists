// The client part of sign-out (#103). It runs before the server sign-out,
// thus the next person on this device gets no data, no pages, and no pushes
// of the last user.
import type { SubscriptionInfo } from "@/shared/push";
import { getClientDb } from "./db";
import { getSyncEngine, stopSync } from "./sync";
import { clearForSignOut } from "./sync/local";

/** Each step can fail alone: the next steps still run. */
async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    console.error(`Sign-out step failed: ${name}`, error);
  }
}

/** Remove the push subscription of this browser, here and on the server. */
async function removePush() {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  const res = await fetch("/api/push/subscriptions", { cache: "no-store" });
  if (res.ok) {
    const { subscriptions } = (await res.json()) as {
      subscriptions: SubscriptionInfo[];
    };
    const row = subscriptions.find((s) => s.endpoint === subscription.endpoint);
    if (row) {
      await fetch(`/api/push/subscriptions/${row.id}`, { method: "DELETE" });
    }
  }
  await subscription.unsubscribe();
}

/**
 * Delete the runtime caches of the service worker: the pages of the user.
 * The precache has only the build files and the offline page: it stays.
 */
async function clearPageCaches() {
  if (typeof caches === "undefined") return;
  for (const name of await caches.keys()) {
    if (!name.includes("precache")) await caches.delete(name);
  }
}

/**
 * Sync the last changes if possible, stop sync, then delete the push
 * subscription, the cached pages, and the local data. The device keeps its
 * client ID and its clock.
 */
export async function clearDeviceForSignOut(): Promise<void> {
  if (navigator.onLine) await step("sync", () => getSyncEngine().sync());
  stopSync();
  await step("push", removePush);
  await step("caches", clearPageCaches);
  await step("data", () => clearForSignOut(getClientDb()));
}
