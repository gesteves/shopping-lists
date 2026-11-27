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
import { IP_ADDRESS_OPTIONS } from "./client-ip";
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
    disabledPaths: DISABLED_PATHS,
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
      ipAddress: IP_ADDRESS_OPTIONS,
    },
    onAPIError: { errorURL: "/sign-in" },
    telemetry: { enabled: false },
    // The limit is for each IP, and all the e2e requests come from one IP.
    // Parallel tests then get 429. The stub is never on in production.
    ...(authStubEnabled(env) && { rateLimit: { enabled: false } }),
    hooks: { before: beforeHook(env) },
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
              // A DCR request with a session cookie checks "create", thus
              // keep it. The other client endpoints, and create-client, are
              // in DISABLED_PATHS. Thus clients come only from CIMD and DCR.
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
 * The endpoints that the app does not use. They give 404 over HTTP. The
 * server code can still call them through `auth.api`.
 */
export const DISABLED_PATHS = [
  // The JWT plugin must not give session JWTs: they have the same signing
  // key as the access tokens.
  "/token",
  // The name and the avatar come only from Google. The name goes into push
  // text, the Claude prompts, and the MCP output.
  "/update-user",
  "/update-session",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  // Google is the only sign-in method, with one account for each user.
  "/sign-up/email",
  "/sign-in/email",
  "/change-password",
  "/request-password-reset",
  "/reset-password",
  "/verify-password",
  "/verify-email",
  "/send-verification-email",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  // Clients come from CIMD and DCR (/oauth2/register). create-client skips
  // the DCR rules: the application_type hook and the rate limit.
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/client/rotate-keys",
  // "Connected apps" in settings uses its own code (#18).
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  // OpenID Connect. The app gives no openid scope.
  "/oauth2/userinfo",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
];

/**
 * The paths that a session of a user who is not in `ALLOWED_EMAILS` can
 * use: the sign-in flow, get-session, and sign-out.
 */
const PATHS_FOR_ANY_SESSION = new Set([
  "/sign-in/social",
  "/callback/:id",
  "/get-session",
  "/sign-out",
  "/e2e/sign-in",
  "/ok",
  "/error",
]);

function beforeHook(env: Env) {
  return createAuthMiddleware(async (ctx) => {
    await allowlistRule(ctx, env);
    oauthRequestRules(ctx);
  });
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * A user who is removed from `ALLOWED_EMAILS` can keep a session for up to
 * 180 days. Refuse that session on each other path, for example the
 * approval of an OAuth client. `getCurrentUser` does the same for the app.
 */
async function allowlistRule(ctx: HookContext, env: Env) {
  if (PATHS_FOR_ANY_SESSION.has(ctx.path)) return;
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  if (!token) return;
  const found = await ctx.context.internalAdapter.findSession(token);
  if (found && !isAllowedEmail(found.user.email, env.ALLOWED_EMAILS)) {
    throw new APIError("FORBIDDEN", {
      code: EMAIL_NOT_ALLOWED,
      message: "This account cannot use this app.",
    });
  }
}

/**
 * Extra rules of MCP 2026-07-28 for the OAuth endpoints:
 *   - An authorization request must have `resource` (RFC 8707). Without it,
 *     the provider gives an opaque token with no `aud`. A token request can
 *     omit it: the code and the refresh token keep the resource.
 *   - A DCR client must send `application_type` (SEP-837). The provider uses
 *     "web" if it is missing.
 */
function oauthRequestRules(ctx: HookContext) {
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
}

export type Auth = ReturnType<typeof createAuth>;

let auth: Auth | undefined;

/** The shared auth instance. It opens the database at first use, not at build. */
export function getAuth(): Auth {
  auth ??= createAuth(getDb());
  return auth;
}
