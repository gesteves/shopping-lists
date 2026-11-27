"use client";

import { useEffect, useState } from "react";
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

/**
 * The setting of this device, and a function that turns it on or off.
 * Undefined until mount, and where the Wake Lock API is missing.
 */
function useKeepScreenOn() {
  const [on, setOn] = useState<boolean>();

  useEffect(() => {
    // Read the browser state one time at mount, then show it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (wakeLockSupported()) setOn(readWakeLockSetting());
  }, []);

  if (on === undefined) return undefined;
  return {
    on,
    toggle() {
      setOn(!on);
      void wakeLock().set(!on);
    },
  };
}

/** The switch. Hidden where the Wake Lock API is missing. */
export function KeepScreenOnSwitch({ hint }: { hint?: string }) {
  const setting = useKeepScreenOn();
  if (!setting) return null;
  return (
    <wa-switch checked={setting.on} onChange={setting.toggle} hint={hint}>
      {copy.settings.keepScreenOn}
    </wa-switch>
  );
}

/** The setting in Settings. Hidden where the Wake Lock API is missing. */
export function KeepScreenOnSetting() {
  const setting = useKeepScreenOn();
  if (!setting) return null;
  return (
    <section aria-labelledby="screen" className="flex flex-col gap-3">
      <h2 id="screen" className="text-xl font-semibold">
        {copy.settings.screen}
      </h2>
      <KeepScreenOnSwitch hint={copy.settings.keepScreenOnHint} />
    </section>
  );
}
