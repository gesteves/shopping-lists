import "server-only";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { getDb, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { isAllowedEmail } from "./allowlist";
import { EMAIL_NOT_ALLOWED } from "./auth-errors";
import { authStub, authStubEnabled } from "./auth-stub";
import {
  ACCESS_TOKEN_TTL,
  ALL_SCOPES,
  REFRESH_TOKEN_TTL,
  appOrigin,
  mcpResource,
} from "./oauth";

type Env = Record<string, string | undefined>;

const DAY = 60 * 60 * 24;

export interface AuthOptions {
  /** For tests: the transport for Client ID Metadata Documents. */
  fetchClientMetadataResource?: ClientMetadataResourceFetch;
}

export function createAuth(
  db: Db,
  env: Env = process.env,
  options: AuthOptions = {},
) {
  const baseURL = env.BETTER_AUTH_URL;
  const origin = baseURL ? appOrigin(env) : undefined;
  return betterAuth({
    appName: "Shopping Lists",
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    // The JWT plugin must not give session JWTs: they have the same signing
    // key as the access tokens.
    disabledPaths: ["/token"],
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
    // The limit is for each IP, and all the e2e requests come from one IP.
    // Parallel tests then get 429. The stub is never on in production.
    ...(authStubEnabled(env) && { rateLimit: { enabled: false } }),
    hooks: { before: oauthRequestRules },
    plugins: [
      ...(authStubEnabled(env) ? [authStub(env)] : []),
      // The OAuth server for MCP clients (#18). See "Authorization" in
      // docs/PLAN.md.
      jwt({
        disableSettingJwtHeader: true,
        // The issuer is the origin, thus the metadata is at the root:
        // /.well-known/oauth-authorization-server.
        jwt: { issuer: origin },
        // With usePlural, the default model name gives the table "jwkss".
        schema: { jwks: { modelName: "jwk" } },
      }),
      ...(baseURL
        ? [
            mcp({
              resource: mcpResource(env),
              loginPage: "/sign-in",
              consentPage: "/oauth/consent",
              scopes: ALL_SCOPES,
              grantTypes: ["authorization_code", "refresh_token"],
              accessTokenExpiresIn: ACCESS_TOKEN_TTL,
              refreshTokenExpiresIn: REFRESH_TOKEN_TTL,
              // DCR is deprecated, but older clients use it (a fallback for
              // CIMD). A registered client gets no access by itself: an
              // allowlisted user must sign in and approve it.
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              clientRegistrationDefaultScopes: ALL_SCOPES,
              // Clients come only from CIMD and DCR. Users cannot read or
              // change clients or resources through the API.
              clientPrivileges: ({ action }) => action === "create",
              resourcePrivileges: () => false,
              // The e2e tests register more than 5 clients a minute from one
              // IP. The stub is never on in production.
              ...(authStubEnabled(env) && { rateLimit: { register: false } }),
            }),
            cimd({
              fetchClientMetadataResource:
                options.fetchClientMetadataResource ??
                fetchClientMetadataResource,
              metadataProfile: "mcp-2026-07-28",
            }),
          ]
        : []),
      // nextCookies must be the last plugin.
      nextCookies(),
    ],
  });
}

/**
 * Extra rules of MCP 2026-07-28 for the OAuth endpoints:
 *   - An authorization request must have `resource` (RFC 8707). Without it,
 *     the provider gives an opaque token with no `aud`. A token request can
 *     omit it: the code and the refresh token keep the resource.
 *   - A DCR client must send `application_type` (SEP-837). The provider uses
 *     "web" if it is missing.
 */
const oauthRequestRules = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/oauth2/authorize") {
    // GET has a query, POST has a form body.
    const params = { ...ctx.query, ...(ctx.body as object | undefined) };
    if (!("resource" in params) || !params.resource) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_target",
        error_description: "the resource parameter is required",
      });
    }
  }
  if (ctx.path === "/oauth2/register") {
    const body: unknown = ctx.body;
    const type =
      body && typeof body === "object" && "application_type" in body
        ? body.application_type
        : undefined;
    if (type !== "web" && type !== "native") {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client_metadata",
        error_description: 'application_type must be "web" or "native"',
      });
    }
  }
});

export type Auth = ReturnType<typeof createAuth>;

let auth: Auth | undefined;

/** The shared auth instance. It opens the database at first use, not at build. */
export function getAuth(): Auth {
  auth ??= createAuth(getDb());
  return auth;
}
