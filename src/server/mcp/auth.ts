// Access tokens for the MCP endpoint (#18). See "Authorization" in
// docs/PLAN.md.
//
// requireMcpAuth (@better-auth/mcp) checks the JWT: signature, `iss`, `aud`
// (the canonical /mcp URI), `exp`, `azp`, and the scopes. It gives 401 with
// `WWW-Authenticate: Bearer resource_metadata="…"`, and 403
// `insufficient_scope`. A JWT stays valid until it expires, thus this guard
// also checks the database at each request:
//   - the token type is "at+jwt" (an OAuth access token, not another JWT);
//   - the user exists and is still in ALLOWED_EMAILS;
//   - the grant (the consent of the user for the client) exists and the
//     client is not disabled. "Connected apps" in settings deletes the grant,
//     thus a revoke stops the access at once;
//   - the token was issued at or after the last consent. Thus a token from
//     before a disconnect does not work again when the user connects the
//     same client again;
//   - the caller gets only the scopes that are in the token and in the
//     consent.
import "server-only";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { requireMcpAuth } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { and, eq } from "drizzle-orm";
import { decodeProtectedHeader, type JWTPayload } from "jose";
import type { Db } from "@/db/client";
import { oauthClients, oauthConsents, users } from "@/db/schema";
import { isAllowedEmail } from "@/lib/allowlist";
import type { Auth } from "@/lib/auth";
import { SCOPES, appOrigin, mcpResource } from "@/lib/oauth";
import { log } from "../log";

type Env = Record<string, string | undefined>;

export interface McpCaller {
  userId: string;
  /** The OAuth client ID: a random ID (DCR) or a URL (CIMD). */
  clientId: string;
  scopes: ReadonlySet<string>;
}

export type McpHandler = (
  request: Request,
  caller: McpCaller,
) => Promise<Response>;

/** The scopes that a 401 tells a client to ask for. Not offline_access. */
const CHALLENGE_SCOPES = [SCOPES.read, SCOPES.write];

/**
 * Throws the 403 `insufficient_scope` error if the caller does not have all
 * the scopes. The guard makes the challenge response from it.
 */
export function requireScopes(caller: McpCaller, scopes: readonly string[]) {
  const missing = scopes.filter((s) => !caller.scopes.has(s));
  if (missing.length > 0) throw createInsufficientScopeError(missing);
}

function scopesOf(claims: JWTPayload): Set<string> {
  return new Set(
    typeof claims.scope === "string" ? claims.scope.split(" ") : [],
  );
}

/** The scopes of a consent row: a JSON array of strings. */
function parseScopes(value: string): string[] {
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** The 401 responses that withMcpAuth made and logged. */
const loggedRefusals = new WeakSet<Response>();

/** True if withMcpAuth made this response, and logged it. */
export function isLoggedRefusal(response: Response): boolean {
  return loggedRefusals.has(response);
}

/** Wraps an MCP route handler with the token checks. */
export function withMcpAuth(
  deps: { auth: () => Auth; db: () => Db; env?: Env },
  handler: McpHandler,
): (request: Request) => Promise<Response> {
  const env = deps.env ?? process.env;
  let guarded: ((request: Request) => Promise<Response>) | undefined;

  return (request) => {
    guarded ??= requireMcpAuth(
      deps.auth(),
      async (req, claims) => {
        const resource = mcpResource(env);
        const userId = claims.sub;
        const clientId = typeof claims.azp === "string" ? claims.azp : "";
        // A valid token that the app refuses: log it (#147). IDs only.
        const reject = (reason: string, description: string) => {
          log.warn("mcp", "refused", {
            status: 401,
            reason,
            user: userId || undefined,
            client: clientId || undefined,
          });
          const response = unauthorized(req, resource, description);
          loggedRefusals.add(response);
          return response;
        };

        if (tokenType(req) !== "at+jwt") {
          return reject("not_access_token", "not an access token");
        }
        if (!userId || !clientId) {
          return reject("no_subject", "no subject or client");
        }

        const db = deps.db();
        const user = db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId))
          .get();
        if (!user || !isAllowedEmail(user.email, env.ALLOWED_EMAILS)) {
          return reject("not_allowed", "the user cannot use this app");
        }
        const grant = db
          .select({
            disabled: oauthClients.disabled,
            scopes: oauthConsents.scopes,
            consentedAt: oauthConsents.updatedAt,
          })
          .from(oauthConsents)
          .innerJoin(
            oauthClients,
            eq(oauthClients.clientId, oauthConsents.clientId),
          )
          .where(
            and(
              eq(oauthConsents.userId, userId),
              eq(oauthConsents.clientId, clientId),
            ),
          )
          .get();
        if (!grant || grant.disabled) {
          return reject("revoked", "access was revoked");
        }
        // The provider keeps the consent time in whole seconds, as iat.
        if (
          typeof claims.iat !== "number" ||
          claims.iat * 1000 < grant.consentedAt.getTime()
        ) {
          return reject("stale_consent", "the token is older than the consent");
        }
        const granted = new Set(parseScopes(grant.scopes));
        const scopes = new Set(
          [...scopesOf(claims)].filter((s) => granted.has(s)),
        );

        return handler(req, { userId, clientId, scopes });
      },
      {
        resource: mcpResource(env),
        issuer: appOrigin(env),
        challengeScopes: CHALLENGE_SCOPES,
      },
    );
    return guarded(request);
  };
}

function tokenType(request: Request): string | undefined {
  const token = request.headers
    .get("authorization")
    ?.replace(/^(Bearer|DPoP)\s+/i, "");
  if (!token) return undefined;
  try {
    return decodeProtectedHeader(token).typ;
  } catch {
    return undefined;
  }
}

/** A 401 with the same Bearer challenge as the library gives. */
function unauthorized(
  request: Request,
  resource: string,
  description: string,
): Response {
  const error = new APIError("UNAUTHORIZED", {
    error: "invalid_token",
    error_description: description,
  });
  const challenge = createResourceServerChallenge(error, resource, {
    request,
    challengeScopes: CHALLENGE_SCOPES,
  });
  const headers = new Headers(challenge?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: description },
      id: null,
    }),
    { status: 401, headers },
  );
}
