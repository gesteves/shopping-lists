"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";
import { revokeConnectedApp } from "@/server/connected-apps";

export async function signOut() {
  // Go to the sign-in page also if the session is already gone.
  await getAuth()
    .api.signOut({ headers: await headers() })
    .catch(() => undefined);
  redirect("/sign-in");
}

/** Disconnects an OAuth client of the signed-in user (#18). */
export async function disconnectApp(clientId: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user || typeof clientId !== "string") return false;
  return revokeConnectedApp(getDb(), user.id, clientId);
}
