// The service worker (#10). See "UI" in docs/PLAN.md.
// scripts/build-sw.mjs bundles it into public/sw.js after `next build`.
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// ⚠️ The API is never cached: sync must see the server, and the SSE stream
// must not go through the worker. This listener comes before the Serwist
// listeners and stops them. Then the browser fetches the request itself.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.stopImmediatePropagation();
  }
});

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Pages are network first, then the cached copy. The app caches each page
  // that it shows (src/app/service-worker.tsx).
  runtimeCaching: defaultCache,
  fallbacks: {
    entries: [
      {
        // A page that this device never opened while online.
        url: "/~offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
