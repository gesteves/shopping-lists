import { describe, expect, it, vi } from "vitest";
import {
  WAKE_LOCK_KEY,
  WakeLockController,
  readWakeLockSetting,
  wakeLockSupported,
  type WakeLockEnv,
} from "./wake-lock";

/** A fake browser: one page, a wake lock, and storage. */
function fakeEnv(options: { fail?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const store = new Map<string, string>();
  const sentinels: {
    released: boolean;
    release: () => Promise<void>;
    addEventListener: (t: "release", l: () => void) => void;
    fire: () => void;
  }[] = [];
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  const env = {
    wakeLock: {
      request: vi.fn(async () => {
        if (options.fail) throw new Error("NotAllowedError");
        let onRelease = () => {};
        const sentinel = {
          released: false,
          async release() {
            sentinel.fire();
          },
          addEventListener: (_: "release", l: () => void) => (onRelease = l),
          fire() {
            if (sentinel.released) return;
            sentinel.released = true;
            onRelease();
          },
        };
        sentinels.push(sentinel);
        return sentinel;
      }),
    },
    document: doc,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  /** The page is hidden (the browser releases the lock), then visible. */
  async function hideAndShow() {
    doc.visibilityState = "hidden";
    sentinels.at(-1)?.fire();
    for (const l of listeners) l();
    doc.visibilityState = "visible";
    for (const l of listeners) l();
    await Promise.resolve();
    await Promise.resolve();
  }
  return {
    env: env as unknown as WakeLockEnv,
    store,
    sentinels,
    listeners,
    hideAndShow,
  };
}

describe("wake lock", () => {
  it("knows if the API is there", () => {
    expect(wakeLockSupported({})).toBe(false);
    expect(wakeLockSupported(fakeEnv().env)).toBe(true);
  });

  it("gets the lock when on, and remembers the setting", async () => {
    const { env, store } = fakeEnv();
    const c = new WakeLockController(undefined, env);
    await c.set(true);
    expect(c.held).toBe(true);
    expect(store.get(WAKE_LOCK_KEY)).toBe("1");
    expect(readWakeLockSetting(env)).toBe(true);

    await c.set(false);
    expect(c.held).toBe(false);
    expect(readWakeLockSetting(env)).toBe(false);
  });

  it("gets the lock again when the page is visible again", async () => {
    const { env, sentinels, hideAndShow } = fakeEnv();
    const c = new WakeLockController(undefined, env);
    await c.set(true);
    await hideAndShow();
    expect(sentinels).toHaveLength(2);
    expect(c.held).toBe(true);
  });

  it("does not get the lock again when the setting is off", async () => {
    const { env, sentinels, hideAndShow } = fakeEnv();
    const c = new WakeLockController(undefined, env);
    await c.set(true);
    await c.set(false);
    await hideAndShow();
    expect(sentinels).toHaveLength(1);
  });

  it("reports a refused request", async () => {
    const onError = vi.fn();
    const c = new WakeLockController(onError, fakeEnv({ fail: true }).env);
    await c.set(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(c.held).toBe(false);
  });

  it("stops listening and releases the lock on dispose", async () => {
    const { env, listeners } = fakeEnv();
    const c = new WakeLockController(undefined, env);
    await c.set(true);
    c.dispose();
    await Promise.resolve();
    expect(listeners.size).toBe(0);
    expect(c.held).toBe(false);
  });
});
