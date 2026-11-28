"use client";

import { useEffect } from "react";
import { clearAppBadge } from "@/client/badge";

/**
 * Clears the app icon badge (#161) when the page loads and each time the
 * app comes to the front: the user then sees the changes. Renders nothing.
 */
export function AppBadgeClearer() {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void clearAppBadge();
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
