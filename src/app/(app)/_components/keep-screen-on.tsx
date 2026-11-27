"use client";

import { useEffect, useState } from "react";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import {
  WakeLockController,
  readWakeLockSetting,
  wakeLockSupported,
} from "@/client/wake-lock";

// "Keep screen on" (#20). The switch is in Settings. The keeper is in the
// app layout: it holds the lock on every page while the setting is on.

let shared: WakeLockController | undefined;

/** One controller for the page, thus one lock. */
function wakeLock(): WakeLockController {
  shared ??= new WakeLockController(() => {
    showToast({ message: copy.settings.keepScreenOnFailed });
  });
  return shared;
}

/** Applies the saved setting of this device. Renders nothing. */
export function WakeLockKeeper() {
  useEffect(() => {
    if (wakeLockSupported() && readWakeLockSetting()) void wakeLock().set(true);
  }, []);
  return null;
}

/** The setting in Settings. Hidden where the Wake Lock API is missing. */
export function KeepScreenOnSetting() {
  const [state, setState] = useState<{ supported: boolean; on: boolean }>();

  useEffect(() => {
    // Read the browser state one time at mount, then show it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ supported: wakeLockSupported(), on: readWakeLockSetting() });
  }, []);

  if (!state?.supported) return null;

  function toggle() {
    const on = !state!.on;
    setState({ supported: true, on });
    void wakeLock().set(on);
  }

  return (
    <section aria-labelledby="screen" className="flex flex-col gap-3">
      <h2 id="screen" className="text-xl font-semibold">
        {copy.settings.screen}
      </h2>
      <wa-switch
        checked={state.on}
        onChange={toggle}
        hint={copy.settings.keepScreenOnHint}
      >
        {copy.settings.keepScreenOn}
      </wa-switch>
    </section>
  );
}
