"use client";

import { useEffect, useRef, useState } from "react";
import { showToast } from "@/client/toasts";
import {
  WakeLockController,
  readWakeLockSetting,
  wakeLockSupported,
} from "@/client/wake-lock";

/**
 * The "Keep screen on" toggle in the header (#20). Hidden where the Screen
 * Wake Lock API is missing. The setting is kept for each device.
 */
export function KeepScreenOn() {
  const controller = useRef<WakeLockController | null>(null);
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!wakeLockSupported()) return;
    const c = new WakeLockController(() => {
      showToast({ message: "The screen can’t stay on right now." });
    });
    controller.current = c;
    const saved = readWakeLockSetting();
    // Read the browser state one time at mount, then show it.
    /* eslint-disable react-hooks/set-state-in-effect */
    setSupported(true);
    setOn(saved);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (saved) void c.set(true);
    return () => c.dispose();
  }, []);

  if (!supported) return null;

  function toggle() {
    const next = !on;
    setOn(next);
    void controller.current?.set(next);
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      title="Keep screen on"
      onClick={toggle}
      className={`inline-flex size-11 items-center justify-center rounded-full text-lg ${
        on ? "bg-accent-soft text-accent" : "text-ink-muted"
      }`}
    >
      <wa-icon name="mobile-screen" label="Keep screen on"></wa-icon>
    </button>
  );
}
