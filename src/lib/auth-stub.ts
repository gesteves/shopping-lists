import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import * as z from "zod";

// A sign-in stub for the e2e tests. It stands in for Google.
//
// The e2e tests run the standalone server, which always sets
// NODE_ENV=production. Thus NODE_ENV cannot gate the stub. All of these must
// be true, or the stub is off:
//   - AUTH_STUB is "1".
//   - BETTER_AUTH_URL is an http URL on a loopback host. Real Google sign-in
//     needs a public https URL, so the real server cannot pass this check.
//   - FLY_APP_NAME is not set. Fly sets it on each machine.

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True only if all the stub conditions are true. Fails closed. */
export function authStubEnabled(env: Env = process.env): boolean {
  if (env.AUTH_STUB !== "1") return false;
  if (env.FLY_APP_NAME) return false;
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? "");
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const query = z.object({
  email: z.email(),
  name: z.string().min(1).default("Test"),
});

/**
 * Adds `GET /api/auth/e2e/sign-in?email=…&name=…`. It goes through the same
 * Better Auth path as the Google callback, so the allowlist check is the same.
 * On success it sets the session cookie and redirects to `/`. On failure it
 * redirects to `/sign-in?error=…`, as the Google callback does.
 */
export function authStub(env: Env = process.env) {
  return {
    id: "e2e-auth-stub",
    endpoints: {
      e2eSignIn: createAuthEndpoint(
        "/e2e/sign-in",
        { method: "GET", query },
        async (c) => {
          // Check again at each request.
          if (!authStubEnabled(env)) throw new APIError("NOT_FOUND");

          const email = c.query.email.toLowerCase();
          const accountId = `e2e:${email}`;
          const fail = (code: string) =>
            c.redirect(`/sign-in?error=${encodeURIComponent(code)}`);

          let result;
          try {
            result = await handleOAuthUserInfo(c, {
              userInfo: {
                id: accountId,
                email,
                name: c.query.name,
                emailVerified: true,
                image: null,
              },
              account: { providerId: "google", accountId },
              callbackURL: "/",
              source: {
                method: "oauth",
                oauth: {
                  providerId: "google",
                  profile: { email, given_name: c.query.name },
                },
              },
            });
          } catch (e) {
            if (isAPIError(e) && e.body?.code) throw fail(e.body.code);
            throw e;
          }
          if (!result.data) {
            throw fail(
              (result.error || "unable_to_sign_in").split(" ").join("_"),
            );
          }

          await setSessionCookie(c, result.data);
          throw c.redirect("/");
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
