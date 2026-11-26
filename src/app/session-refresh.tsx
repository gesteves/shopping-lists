"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Asks the server for the session when the app opens or comes back to the
 * front. The server then extends the session and the cookie (rolling).
 */
export function SessionRefresh() {
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void authClient.getSession();
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return null;
}
