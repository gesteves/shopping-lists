"use client";

import { useEffect } from "react";
import { startSync } from "@/client/sync";

/** Starts the sync engine for the signed-in user. It shows nothing. */
export function SyncStarter({ userId }: { userId: string }) {
  useEffect(() => startSync(userId), [userId]);
  return null;
}
