"use client";

import { useEffect, useSyncExternalStore } from "react";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import {
  WakeLockController,
  readWakeLockSetting,
  wakeLockSupported,
} from "@/client/wake-lock";

// "Keep screen on" (#20). The switch is in Settings and on the list page
// (#82). The keeper is in the app layout: it holds the lock on every page
// while the setting is on.

let shared: WakeLockController | undefined;

const TOAST_SHOWN = "shopping-lists.wake-lock-toast";

/**
 * Tell about a refused lock one time in each session. The keeper asks again
 * at each return to the app, and a toast each time is too much (#104).
 */
function toastOncePerSession() {
  try {
    if (sessionStorage.getItem(TOAST_SHOWN)) return;
    sessionStorage.setItem(TOAST_SHOWN, "1");
  } catch {
    // No sessionStorage: show the toast.
  }
  showToast({ message: copy.settings.keepScreenOnFailed });
}

/** One controller for the page, thus one lock. */
function wakeLock(): WakeLockController {
  shared ??= new WakeLockController(toastOncePerSession);
  return shared;
}

/** Applies the saved setting of this device. Renders nothing. */
export function WakeLockKeeper() {
  useEffect(() => {
    if (wakeLockSupported() && readWakeLockSetting()) void wakeLock().set(true);
  }, []);
  return null;
}

/** The setting of this page. Read from storage one time. */
let saved: boolean | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The setting of this device. Null where the Wake Lock API is missing. */
function snapshot(): boolean | null {
  if (!wakeLockSupported()) return null;
  saved ??= readWakeLockSetting();
  return saved;
}

/** On the server and while the page hydrates, the browser is not known. */
function serverSnapshot(): undefined {
  return undefined;
}

/**
 * Save the setting, and get or release the lock. Keep the value here too:
 * private mode can refuse storage.
 */
function setKeepScreenOn(on: boolean) {
  saved = on;
  void wakeLock().set(on);
  listeners.forEach((listener) => listener());
}

/**
 * The setting of this device: undefined until it is known, null where the
 * Wake Lock API is missing. A mount after hydration (the list page) knows it
 * at the first render, thus the switch does not change after it shows.
 */
function useKeepScreenOn() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * The switch. It is always in the page, thus it does not pop in (#136). It
 * is disabled until the setting is known, and where the Wake Lock API is
 * missing.
 */
export function KeepScreenOnSwitch({ hint }: { hint?: string }) {
  const on = useKeepScreenOn();
  return (
    <wa-switch
      disabled={on == null}
      checked={on === true}
      onChange={(event) =>
        setKeepScreenOn(
          (event.currentTarget as unknown as HTMLInputElement).checked,
        )
      }
      hint={hint}
    >
      {copy.settings.keepScreenOn}
    </wa-switch>
  );
}

/** The setting in Settings. Where the Wake Lock API is missing, the hint tells so. */
export function KeepScreenOnSetting() {
  const on = useKeepScreenOn();
  return (
    <section aria-labelledby="screen" className="flex flex-col gap-3">
      <h2 id="screen" className="text-xl font-semibold">
        {copy.settings.screen}
      </h2>
      <KeepScreenOnSwitch
        hint={
          on === null
            ? copy.settings.keepScreenOnUnsupported
            : copy.settings.keepScreenOnHint
        }
      />
    </section>
  );
}
