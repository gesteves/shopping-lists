import { describe, expect, it } from "vitest";
import { DROP_AT_UPDATE } from "../sw/page-cache";
import {
  addToBadge,
  BADGE_CACHE,
  clearBadge,
  readBadgeCount,
  type BadgeNavigator,
} from "./badge";

/** Cache Storage in memory. Each open of a name gives the same entries. */
function fakeStorage() {
  const caches = new Map<string, Map<string, string>>();
  const storage = {
    async open(name: string) {
      let entries = caches.get(name);
      if (!entries) caches.set(name, (entries = new Map()));
      const store = entries;
      return {
        async match(key: string) {
          const body = store.get(key);
          return body === undefined ? undefined : new Response(body);
        },
        async put(key: string, response: Response) {
          store.set(key, await response.text());
        },
      };
    },
    async delete(name: string) {
      return caches.delete(name);
    },
  };
  return { caches, storage: storage as unknown as CacheStorage };
}

function fakeNavigator(options: { refuse?: boolean } = {}) {
  const shown: (number | "clear")[] = [];
  const nav: BadgeNavigator = {
    setAppBadge: async (n) => {
      if (options.refuse) throw new Error("NotAllowedError");
      shown.push(n ?? 0);
    },
    clearAppBadge: async () => {
      if (options.refuse) throw new Error("NotAllowedError");
      shown.push("clear");
    },
  };
  return { nav, shown };
}

describe("app icon badge", () => {
  it("adds 1 for each push and shows the count", async () => {
    const { storage } = fakeStorage();
    const { nav, shown } = fakeNavigator();
    await addToBadge(storage, nav);
    await addToBadge(storage, nav);
    expect(shown).toEqual([1, 2]);
    expect(await readBadgeCount(storage)).toBe(2);
  });

  it("keeps the count when the worker starts again", async () => {
    const { storage } = fakeStorage();
    await addToBadge(storage, fakeNavigator().nav);
    // A new worker: no state in memory, only the cache.
    const { nav, shown } = fakeNavigator();
    await addToBadge(storage, nav);
    expect(shown).toEqual([2]);
  });

  it("clears the badge and the count", async () => {
    const { storage, caches } = fakeStorage();
    const { nav, shown } = fakeNavigator();
    await addToBadge(storage, nav);
    await clearBadge(storage, nav);
    expect(shown).toEqual([1, "clear"]);
    expect(caches.has(BADGE_CACHE)).toBe(false);
    await addToBadge(storage, nav);
    expect(shown.at(-1)).toBe(1);
  });

  it("does nothing where the browser shows no badge", async () => {
    const { storage, caches } = fakeStorage();
    await addToBadge(storage, {});
    await clearBadge(storage, {});
    await clearBadge(undefined, {});
    expect(caches.size).toBe(0);
  });

  it("does not reject when the browser refuses the badge", async () => {
    const { storage } = fakeStorage();
    const { nav } = fakeNavigator({ refuse: true });
    await expect(addToBadge(storage, nav)).resolves.toBeUndefined();
    await expect(clearBadge(storage, nav)).resolves.toBeUndefined();
    expect(await readBadgeCount(storage)).toBe(0);
  });

  it("a new version of the worker keeps the count", () => {
    expect(DROP_AT_UPDATE).not.toContain(BADGE_CACHE);
  });

  it("reads a bad stored value as 0", async () => {
    const { storage } = fakeStorage();
    const cache = await storage.open(BADGE_CACHE);
    await cache.put("/badge-count", new Response("not a number"));
    expect(await readBadgeCount(storage)).toBe(0);
  });
});
