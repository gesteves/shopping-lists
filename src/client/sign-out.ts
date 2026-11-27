// The client part of sign-out (#103). It runs before the server sign-out,
// thus the next person on this device gets no data, no pages, and no pushes
// of the last user.
import { CLEAR_PAGES_MESSAGE } from "@/shared/offline";
import type { SubscriptionInfo } from "@/shared/push";
import { getClientDb } from "./db";
import { getSyncEngine, stopSync } from "./sync";
import { clearForSignOut, pendingCount } from "./sync/local";

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

/** The time that the sign-out waits for the service worker. */
const WORKER_TIMEOUT_MS = 5000;

/**
 * Tell the service worker to delete its page caches, and wait for its
 * answer. A fetch of the worker that started before (for example the list
 * shell of a CACHE_URLS message) then does not put a page back (#119).
 */
async function clearWorkerCaches() {
  const worker = (await navigator.serviceWorker?.getRegistration())?.active;
  if (!worker) return;
  const channel = new MessageChannel();
  await Promise.race([
    new Promise((resolve) => {
      channel.port1.onmessage = resolve;
      worker.postMessage({ type: CLEAR_PAGES_MESSAGE }, [channel.port2]);
    }),
    new Promise((resolve) => setTimeout(resolve, WORKER_TIMEOUT_MS)),
  ]);
  channel.port1.close();
}

/**
 * Delete the runtime caches of the service worker: the pages of the user.
 * The precache has only the build files and the offline page: it stays.
 * The worker deletes them first. Then this page deletes them too, also if
 * the worker did not answer.
 */
async function clearPageCaches() {
  if (typeof caches === "undefined") return;
  await step("worker caches", clearWorkerCaches);
  for (const name of await caches.keys()) {
    if (!name.includes("precache")) await caches.delete(name);
  }
}

/**
 * Sync the last changes if the browser is online. It gives the number of
 * ops that the server does not have. The sync does not reject on an error,
 * thus count after it (#115). If there are some, ask before sign-out: the
 * sign-out deletes them.
 */
export async function syncBeforeSignOut(): Promise<number> {
  if (navigator.onLine) await step("sync", () => getSyncEngine().sync());
  try {
    return await pendingCount(getClientDb());
  } catch (error) {
    console.error("Sign-out step failed: count", error);
    return 0;
  }
}

/**
 * Stop sync, then delete the push subscription, the cached pages, and the
 * local data. Call syncBeforeSignOut() first. The device keeps its client
 * ID and its clock.
 */
export async function clearDeviceForSignOut(): Promise<void> {
  stopSync();
  await step("push", removePush);
  await step("caches", clearPageCaches);
  await step("data", () => clearForSignOut(getClientDb()));
}
