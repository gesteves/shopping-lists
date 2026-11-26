"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";

export async function signOut() {
  // Go to the sign-in page also if the session is already gone.
  await getAuth()
    .api.signOut({ headers: await headers() })
    .catch(() => undefined);
  redirect("/sign-in");
}
