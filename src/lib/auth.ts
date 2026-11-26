import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { isAllowedEmail } from "./allowlist";
import { EMAIL_NOT_ALLOWED } from "./auth-errors";
import { authStub, authStubEnabled } from "./auth-stub";

type Env = Record<string, string | undefined>;

const DAY = 60 * 60 * 24;

export function createAuth(db: Db, env: Env = process.env) {
  const baseURL = env.BETTER_AUTH_URL;
  return betterAuth({
    appName: "Shopping Lists",
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      usePlural: true,
    }),
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
        prompt: "select_account",
        // Keep the name and the avatar current.
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: (profile) => ({
          name: profile.given_name || profile.name,
          image: profile.picture,
        }),
      },
    },
    user: {
      // Runs before a user row is made, and again at each Google sign-in.
      validateUserInfo: ({ user, source }) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "google")
          return { error: "method_not_allowed" };
        if (
          user.emailVerified !== true ||
          !isAllowedEmail(user.email, env.ALLOWED_EMAILS)
        )
          return {
            error: EMAIL_NOT_ALLOWED,
            errorDescription: "This account cannot use this app.",
          };
      },
    },
    session: {
      // Rolling sessions. Signing in again in an iOS PWA is difficult.
      expiresIn: 180 * DAY,
      updateAge: DAY,
    },
    advanced: {
      useSecureCookies: baseURL?.startsWith("https://") ?? false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    onAPIError: { errorURL: "/sign-in" },
    telemetry: { enabled: false },
    // nextCookies must be the last plugin.
    plugins: [...(authStubEnabled(env) ? [authStub(env)] : []), nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let auth: Auth | undefined;

/** The shared auth instance. It opens the database at first use, not at build. */
export function getAuth(): Auth {
  auth ??= createAuth(getDb());
  return auth;
}
