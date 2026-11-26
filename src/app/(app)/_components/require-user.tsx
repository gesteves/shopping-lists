import { requireUser } from "@/lib/session";

/** Put it in a Suspense boundary on each page: it sends a guest to sign in. */
export async function RequireUser() {
  await requireUser();
  return null;
}
