// The rules of the page caches (#117). A separate file, so that the tests
// can use it outside the worker.

/** The HTML of the app pages. */
export const PAGE_CACHE = "pages";
/** The RSC payloads of the app pages. */
export const RSC_CACHE = "pages-rsc";
/**
 * The caches that a new version deletes: the RSC payloads, and two caches
 * of `defaultCache` where older versions kept the RSC prefetches and the
 * other pages (sign-in, consent).
 */
export const DROP_AT_UPDATE = [RSC_CACHE, "pages-rsc-prefetch", "others"];

/**
 * An app page that works offline: `/`, `/settings`, and `/lists/<id>`. The
 * list shell (`/lists/shell`) is a list page too. Other pages (sign-in,
 * OAuth consent, `/.well-known/*`) are never cached.
 */
export function isAppPage(url: URL): boolean {
  const path = url.pathname;
  return path === "/" || path === "/settings" || /^\/lists\/[^/]+$/.test(path);
}

/**
 * Next.js puts this text in a page or an RSC payload that redirects after
 * the response started (`redirect()` in a Suspense boundary). For example,
 * `requireUser()` with a cookie whose session is gone.
 */
const STREAMED_REDIRECT = "NEXT_REDIRECT";

/**
 * True if the response can replace a cached page. A redirect cannot: the
 * 307 of `src/proxy.ts` (an `opaqueredirect` with status 0, or a followed
 * redirect), and a redirect in the stream.
 */
export async function isGoodPage(response: Response): Promise<boolean> {
  if (!response.ok || response.type !== "basic" || response.redirected) {
    return false;
  }
  const body = await response.clone().text();
  return !body.includes(STREAMED_REDIRECT);
}

/** The time for all the fetches of `refreshPages`. */
export const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_CONCURRENCY = 4;

/** The parts of a Cache that `refreshPages` uses. */
export interface CacheLike {
  keys(): Promise<readonly Request[]>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * At the activate of a new version: fetch each cached page again. A page of
 * the old version loads the old `/_next/static` files, and the new worker
 * removed them from the precache. Thus a page that fails is deleted, and
 * offline a list then gets the list shell. A page that is not an app page
 * is deleted too.
 */
export async function refreshPages(
  cache: CacheLike,
  fetchPage: FetchLike,
  timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const queue = [...(await cache.keys())];
  const refreshOne = async (request: Request) => {
    if (isAppPage(new URL(request.url))) {
      try {
        const response = await fetchPage(request.url, {
          credentials: "same-origin",
          redirect: "manual",
          cache: "no-store",
          signal,
        });
        if (await isGoodPage(response)) {
          await cache.put(request, response);
          return;
        }
      } catch {
        // Offline, or the time is out: delete the page.
      }
    }
    await cache.delete(request);
  };
  const runner = async () => {
    for (let request = queue.shift(); request; request = queue.shift()) {
      await refreshOne(request);
    }
  };
  await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, runner));
}
