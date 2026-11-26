import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isAllowedEmail } from "./allowlist";
import { getAuth } from "./auth";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

/**
 * The signed-in user, or null. A user who is no longer in `ALLOWED_EMAILS`
 * counts as signed out. Call it in a Suspense boundary: it reads the request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Server Components cannot set cookies. Thus do not refresh the session
  // here. <SessionRefresh> refreshes it through the route handler.
  // Read the headers first. At build time this stops the render before the
  // database opens.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true },
  });
  if (!session) return null;
  const { id, name, email, image } = session.user;
  if (!isAllowedEmail(email, process.env.ALLOWED_EMAILS)) return null;
  return { id, name, email, image: image ?? null };
});

/** The signed-in user. Redirects to `/sign-in` if there is none. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** For route handlers: the user, or a 401 JSON response. */
export async function requireApiUser(): Promise<CurrentUser | Response> {
  const user = await getCurrentUser();
  return user ?? Response.json({ error: "unauthorized" }, { status: 401 });
}
