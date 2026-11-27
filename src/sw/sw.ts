// The service worker (#10). See "UI" in docs/PLAN.md.
// scripts/build-sw.mjs bundles it into public/sw.js after `next build`.
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type {
  PrecacheEntry,
  RouteMatchCallback,
  SerwistGlobalConfig,
  SerwistPlugin,
} from "serwist";
import { ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist } from "serwist";
import { copy } from "../copy";
import { LIST_SHELL_PATH } from "../shared/offline";
import { openUrl, targetUrl } from "./open-url";
import {
  DROP_AT_UPDATE,
  isAppPage,
  isGoodPage,
  PAGE_CACHE,
  refreshPages,
  RSC_CACHE,
} from "./page-cache";

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

// Pages and RSC payloads (#103). The default rules keep a page for 24 h
// from the fetch. Thus a cold start offline one day after the last use gave
// /~offline, also with all the data in IndexedDB. These rules come before
// the default rules: network first with a short wait, then the copy, for 30
// days from the last use.
const PAGE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const NETWORK_TIMEOUT_SECONDS = 3;

/**
 * Keep only a good page (#117). The default plugin of NetworkFirst keeps
 * status 0 too, thus a 307 to /sign-in replaced the cached page.
 */
const goodPagesOnly: SerwistPlugin = {
  cacheWillUpdate: async ({ response }) =>
    (await isGoodPage(response)) ? response : null,
};

function pageCache(cacheName: string, plugins: SerwistPlugin[] = []) {
  return new NetworkFirst({
    cacheName,
    networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
    plugins: [
      goodPagesOnly,
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: PAGE_MAX_AGE_SECONDS,
        maxAgeFrom: "last-used",
      }),
      ...plugins,
    ],
  });
}

/** A same-origin page: not the API, not a build or static file. */
function isSameOriginPage(url: URL, sameOrigin: boolean): boolean {
  return (
    sameOrigin &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/_next/") &&
    !/\.[a-z0-9]+$/i.test(url.pathname)
  );
}

/**
 * The RSC payload of a navigation. A prefetch is not cached: Next.js 16
 * sends `Next-Router-Prefetch` with the values 1, 2, or 3 (#117). A
 * prefetch that ended after the sign-out cleared the caches put a page of
 * the user back in the cache.
 */
const isRsc: RouteMatchCallback = ({ request, url, sameOrigin }) =>
  request.headers.get("RSC") === "1" &&
  !request.headers.has("Next-Router-Prefetch") &&
  isSameOriginPage(url, sameOrigin) &&
  isAppPage(url);

/**
 * A page: a navigation, or a CACHE_URLS request from the app (a plain GET
 * with no RSC header, src/app/service-worker.tsx).
 */
const isPage: RouteMatchCallback = ({ request, url, sameOrigin }) =>
  request.method === "GET" &&
  request.headers.get("RSC") !== "1" &&
  isSameOriginPage(url, sameOrigin) &&
  isAppPage(url);

/**
 * Each other same-origin page, and each RSC prefetch: never cached (#117).
 * Without this rule, the "others" rule of `defaultCache` keeps them: also
 * the consent page, with its signed query.
 */
const isOtherPage: RouteMatchCallback = ({ url, sameOrigin }) =>
  isSameOriginPage(url, sameOrigin);

const OFFLINE_PATH = "/~offline";

/**
 * A page that is not in the cache, offline. A list: the cached list shell.
 * The list page reads the list ID from the URL, and the data from
 * IndexedDB. Another page: /~offline. Serwist does not add its fallback to a
 * handler with a handlerDidError plugin, thus this plugin gives both.
 */
const pageFallback: SerwistPlugin = {
  handlerDidError: async ({ request }) => {
    if (new URL(request.url).pathname.startsWith("/lists/")) {
      const cache = await caches.open(PAGE_CACHE);
      const shell = await cache.match(LIST_SHELL_PATH, { ignoreVary: true });
      if (shell) return shell;
    }
    if (request.destination !== "document") return undefined;
    return serwist.matchPrecache(OFFLINE_PATH);
  },
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Pages are network first, then the cached copy. The app caches each page
  // that it shows, and the list shell (src/app/service-worker.tsx).
  runtimeCaching: [
    { matcher: isRsc, handler: pageCache(RSC_CACHE) },
    { matcher: isPage, handler: pageCache(PAGE_CACHE, [pageFallback]) },
    { matcher: isOtherPage, handler: new NetworkOnly() },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        // A page that this device never opened while online.
        url: OFFLINE_PATH,
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();

// A new version (#117). Its precache does not have the `/_next/static` files
// of the old version, and the server does not serve them. A cached page of
// the old version can load them only from the HTTP cache of the browser,
// thus offline it often does not start. Fetch each cached page again, and
// delete the RSC payloads and the other pages of the old version.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of DROP_AT_UPDATE) {
        await caches.delete(name);
      }
      if (await caches.has(PAGE_CACHE)) {
        await refreshPages(await caches.open(PAGE_CACHE), (url, init) =>
          fetch(url, init),
        );
      }
    })(),
  );
});

// Push (#15). The payload is a PushPayload (src/shared/push.ts).
self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string };
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || copy.push.title, {
      body: data.body ?? "",
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data?.url, self.location.origin);
  event.waitUntil(openUrl(self.clients, url));
});
