import { describe, expect, it, vi } from "vitest";
import {
  WAKE_LOCK_KEY,
  WakeLockController,
  readWakeLockSetting,
  wakeLockSupported,
  type WakeLockEnv,
} from "./wake-lock";

/** A fake browser: one page, a wake lock, and storage. */
function fakeEnv(options: { fail?: boolean; defer?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const store = new Map<string, string>();
  const sentinels: {
    released: boolean;
    release: () => Promise<void>;
    addEventListener: (t: "release", l: () => void) => void;
    fire: () => void;
  }[] = [];
  /** With `defer`: each open request, resolved by a call. */
  const open: (() => void)[] = [];
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  const env = {
    wakeLock: {
      request: vi.fn(async () => {
        if (options.fail) throw new Error("NotAllowedError");
        if (options.defer) {
          await new Promise<void>((resolve) => open.push(resolve));
        }
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
    open,
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

  it("releases a lock that arrives after dispose", async () => {
    const { env, sentinels, open } = fakeEnv({ defer: true });
    const c = new WakeLockController(undefined, env);
    const done = c.set(true);
    await vi.waitFor(() => expect(open).toHaveLength(1));
    c.dispose();
    open[0]();
    await done;
    expect(c.on).toBe(false);
    expect(c.held).toBe(false);
    expect(sentinels[0].released).toBe(true);
  });

  it("makes one request for two acquires at the same time", async () => {
    const { env, sentinels, listeners, open } = fakeEnv({ defer: true });
    const c = new WakeLockController(undefined, env);
    const done = c.set(true);
    // The page becomes visible while the first request is open.
    for (const l of listeners) l();
    await vi.waitFor(() => expect(open).toHaveLength(1));
    open[0]();
    await done;
    await Promise.resolve();
    expect(env.wakeLock!.request).toHaveBeenCalledOnce();
    expect(c.held).toBe(true);

    // Off releases the one lock: the screen does not stay on.
    await c.set(false);
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0].released).toBe(true);
    expect(c.held).toBe(false);
  });

  it("keeps the lock of an open request when the setting goes off and on", async () => {
    const { env, sentinels, open } = fakeEnv({ defer: true });
    const c = new WakeLockController(undefined, env);
    const first = c.set(true);
    await vi.waitFor(() => expect(open).toHaveLength(1));
    const off = c.set(false);
    const on = c.set(true);
    open[0]();
    await Promise.all([first, off, on]);
    expect(sentinels).toHaveLength(1);
    expect(c.held).toBe(true);
  });
});
