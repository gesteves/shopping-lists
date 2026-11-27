// Shared values for the OAuth server of the MCP endpoint (#18). See
// "Authorization" in docs/PLAN.md.

type Env = Record<string, string | undefined>;

export const SCOPES = {
  read: "lists:read",
  write: "lists:write",
  offline: "offline_access",
} as const;

/** All the scopes that the server gives, in the order of the metadata. */
export const ALL_SCOPES = [SCOPES.read, SCOPES.write, SCOPES.offline];

/** The access token lifetime, in seconds. Short, because a JWT stays valid. */
export const ACCESS_TOKEN_TTL = 15 * 60;
/** The refresh token lifetime, in seconds. Each refresh starts it again. */
export const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60;

/** The app origin, with no trailing slash. It is also the OAuth issuer. */
export function appOrigin(env: Env = process.env): string {
  const url = env.BETTER_AUTH_URL;
  if (!url) throw new Error("BETTER_AUTH_URL is not set");
  return new URL(url).origin;
}

/** The canonical URI of the MCP server (RFC 8707). Each token `aud` is this. */
export function mcpResource(env: Env = process.env): string {
  return `${appOrigin(env)}/mcp`;
}

/** What each scope lets an app do, for the consent page and settings. */
export const SCOPE_TEXT: Record<string, string> = {
  [SCOPES.read]: "See your lists and items",
  [SCOPES.write]: "Add, change, check off, and delete lists and items",
  [SCOPES.offline]: "Stay connected when you aren’t using it",
};

/**
 * The host that a user can check: the host of an https client ID (CIMD) or
 * of a redirect URI. A private-use scheme (com.example.app:/cb) has no host,
 * thus it gives the whole URI.
 */
export function displayHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host || uri;
  } catch {
    return uri;
  }
}

/** True for an http redirect on localhost or a loopback IP. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const { protocol, hostname } = new URL(uri);
    return (
      protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    );
  } catch {
    return false;
  }
}
