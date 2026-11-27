import { describe, expect, it } from "vitest";
import {
  isAppPage,
  isGoodPage,
  pageCachePlugin,
  refreshPages,
  type CacheLike,
  type FetchLike,
} from "./page-cache";

const ORIGIN = "https://lists.example";

/** A response with the type of a browser response. Node gives "default". */
function page(
  body: string,
  {
    status = 200,
    type = "basic",
    redirected = false,
  }: { status?: number; type?: ResponseType; redirected?: boolean } = {},
): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "type", { value: type });
  Object.defineProperty(response, "redirected", { value: redirected });
  return response;
}

/** A 307 that the worker gets with `redirect: "manual"`. */
function opaqueRedirect(): Response {
  const response = new Response(null);
  Object.defineProperty(response, "status", { value: 0 });
  Object.defineProperty(response, "ok", { value: false });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
}

describe("isAppPage", () => {
  it.each(["/", "/settings", "/lists/abc", "/lists/shell", "/?x=1"])(
    "caches %s",
    (path) => {
      expect(isAppPage(new URL(path, ORIGIN))).toBe(true);
    },
  );

  it.each([
    "/sign-in",
    "/oauth/consent?client_id=a&sig=b",
    "/.well-known/oauth-authorization-server",
    "/~offline",
    "/mcp",
    "/lists",
    "/lists/a/b",
    "/settings/x",
  ])("does not cache %s", (path) => {
    expect(isAppPage(new URL(path, ORIGIN))).toBe(false);
  });
});

describe("isGoodPage", () => {
  it("keeps a normal page", async () => {
    expect(await isGoodPage(page("<html>List</html>"))).toBe(true);
  });

  it("refuses a redirect, an error, and an opaque response", async () => {
    expect(await isGoodPage(opaqueRedirect())).toBe(false);
    expect(await isGoodPage(page("sign in", { redirected: true }))).toBe(false);
    expect(await isGoodPage(page("", { status: 500 }))).toBe(false);
    expect(await isGoodPage(page("", { type: "opaque" }))).toBe(false);
  });

  it("refuses a page that redirects in the stream", async () => {
    const body =
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/sign-in"/>' +
      '<script>self.__next_f.push([1,"{\\"digest\\":\\"NEXT_REDIRECT;replace;/sign-in;307;\\"}"])</script>';
    expect(await isGoodPage(page(body))).toBe(false);
  });

  it("leaves the body of the response for the cache", async () => {
    const response = page("<html>List</html>");
    await isGoodPage(response);
    expect(await response.text()).toBe("<html>List</html>");
  });
});

function fakeCache(paths: string[]) {
  const entries = new Map<string, string>(
    paths.map((p) => [`${ORIGIN}${p}`, "old"]),
  );
  const cache: CacheLike = {
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    put: async (request, response) => {
      entries.set(request.url, await response.text());
    },
    delete: async (request) => entries.delete(request.url),
  };
  return { cache, entries };
}

describe("refreshPages", () => {
  it("puts the new copy of each page, and deletes the pages that fail", async () => {
    const { cache, entries } = fakeCache([
      "/",
      "/lists/a",
      "/lists/b",
      "/lists/c",
      "/settings",
      "/lists/shell",
      "/sign-in",
      "/oauth/consent?sig=x",
    ]);
    const asked: string[] = [];
    const fetchPage: FetchLike = async (url, init) => {
      asked.push(new URL(url).pathname);
      expect(init).toMatchObject({ redirect: "manual", cache: "no-store" });
      const path = new URL(url).pathname;
      if (path === "/lists/a") return opaqueRedirect();
      if (path === "/lists/b") throw new TypeError("offline");
      if (path === "/lists/c") return page("", { status: 404 });
      return page(`new ${path}`);
    };

    await refreshPages(cache, fetchPage);

    expect(Object.fromEntries(entries)).toEqual({
      [`${ORIGIN}/`]: "new /",
      [`${ORIGIN}/settings`]: "new /settings",
      [`${ORIGIN}/lists/shell`]: "new /lists/shell",
    });
    // A page that is not an app page is deleted with no fetch.
    expect(asked).not.toContain("/sign-in");
    expect(asked).not.toContain("/oauth/consent");
  });

  it("deletes the pages that are not done in time", async () => {
    const { cache, entries } = fakeCache(["/", "/settings"]);
    const fetchPage: FetchLike = (url, init) =>
      new URL(url).pathname === "/"
        ? Promise.resolve(page("new"))
        : new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            ),
          );

    await refreshPages(cache, fetchPage, 50);

    expect([...entries.keys()]).toEqual([`${ORIGIN}/`]);
  });
});

describe("pageCachePlugin", () => {
  const event = {} as ExtendableEvent;
  const request = new Request(`${ORIGIN}/lists/shell`);

  /** One fetch of the strategy: its own plugin state. */
  function start(plugin: ReturnType<typeof pageCachePlugin>["plugin"]) {
    const state = {};
    void plugin.handlerWillStart?.({ request, event, state });
    return (response: Response) =>
      plugin.cacheWillUpdate?.({ request, response, event, state });
  }

  it("keeps a good page, and not a redirect", async () => {
    const { plugin } = pageCachePlugin();
    const good = page("<html>");
    expect(await start(plugin)(good)).toBe(good);
    expect(await start(plugin)(opaqueRedirect())).toBeNull();
  });

  it("does not keep a page whose fetch started before a clear (#119)", async () => {
    const { plugin, clear } = pageCachePlugin();
    const before = start(plugin);
    clear();
    const after = start(plugin);
    expect(await before(page("<html>"))).toBeNull();
    const good = page("<html>");
    expect(await after(good)).toBe(good);
  });
});
