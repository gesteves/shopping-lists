// "Keep screen on" (#20): the Screen Wake Lock API. The setting is kept for
// each device (localStorage). The browser releases the lock when the page
// is hidden, thus the controller requests it again when the page is
// visible again.

export const WAKE_LOCK_KEY = "keep-screen-on";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockEnv {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
  document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

function browserEnv(): WakeLockEnv {
  return {
    wakeLock: (navigator as { wakeLock?: WakeLockEnv["wakeLock"] }).wakeLock,
    document,
    storage: localStorage,
  };
}

/** True if the browser has the Screen Wake Lock API. */
export function wakeLockSupported(
  env: Pick<WakeLockEnv, "wakeLock"> = browserEnv(),
) {
  return typeof env.wakeLock?.request === "function";
}

/** The saved setting of this device. */
export function readWakeLockSetting(
  env: Pick<WakeLockEnv, "storage"> = browserEnv(),
) {
  try {
    return env.storage.getItem(WAKE_LOCK_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Keeps the lock while the setting is on. `onError` gets a failed request,
 * for example when the battery is low.
 */
export class WakeLockController {
  #env: WakeLockEnv;
  #sentinel: WakeLockSentinelLike | null = null;
  #on = false;
  #onError: (error: unknown) => void;
  #onVisibility = () => {
    if (this.#env.document.visibilityState === "visible") void this.#acquire();
  };

  constructor(
    onError: (error: unknown) => void = () => {},
    env: WakeLockEnv = browserEnv(),
  ) {
    this.#env = env;
    this.#onError = onError;
    env.document.addEventListener("visibilitychange", this.#onVisibility);
  }

  get on() {
    return this.#on;
  }

  /** True while the screen lock is held. */
  get held() {
    return this.#sentinel !== null && !this.#sentinel.released;
  }

  /** Turns the setting on or off, saves it, and gets or releases the lock. */
  async set(on: boolean): Promise<void> {
    this.#on = on;
    try {
      if (on) this.#env.storage.setItem(WAKE_LOCK_KEY, "1");
      else this.#env.storage.removeItem(WAKE_LOCK_KEY);
    } catch {
      // Private mode can refuse storage. The setting stays for this page.
    }
    if (on) await this.#acquire();
    else await this.#release();
  }

  async #acquire() {
    if (!this.#on || this.held || !this.#env.wakeLock) return;
    if (this.#env.document.visibilityState !== "visible") return;
    try {
      const sentinel = await this.#env.wakeLock.request("screen");
      // The setting changed while the request was open.
      if (!this.#on) return void (await sentinel.release());
      this.#sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.#sentinel === sentinel) this.#sentinel = null;
      });
    } catch (error) {
      this.#onError(error);
    }
  }

  async #release() {
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (sentinel && !sentinel.released) await sentinel.release();
  }

  /** Stops listening, and releases the lock. The setting stays. */
  dispose() {
    this.#env.document.removeEventListener(
      "visibilitychange",
      this.#onVisibility,
    );
    void this.#release();
  }
}
