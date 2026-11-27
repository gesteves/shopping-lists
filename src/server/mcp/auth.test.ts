// Contract tests of the OAuth server and the token checks of /mcp (#18).
// See "Authorization" and "Verification" in docs/PLAN.md.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { openDatabase, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { oauthClients, users } from "@/db/schema";
import { createAuth } from "@/lib/auth";
import { SCOPES } from "@/lib/oauth";
import { listConnectedApps, revokeConnectedApp } from "../connected-apps";
import { requireScopes, withMcpAuth } from "./auth";

const BASE = "http://localhost:3000";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "http://127.0.0.1:9999/callback";
const ALL = "lists:read lists:write offline_access";

const env = {
  AUTH_STUB: "1",
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  ALLOWED_EMAILS: "allowed@example.com",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

// Client ID Metadata Documents on https://client.test, served in-process.
const CIMD_ID = "https://client.test/oauth/client.json";
const cimdDocs = new Map<string, unknown>([
  [
    CIMD_ID,
    {
      client_id: CIMD_ID,
      client_name: "Metadata Client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  ],
  [
    "https://client.test/wrong-id.json",
    {
      client_id: "https://client.test/other.json",
      client_name: "Wrong",
      redirect_uris: [REDIRECT],
    },
  ],
]);
const fetched: string[] = [];
async function fakeTransport(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  const doc = cimdDocs.get(url);
  if (!doc) return new Response("not found", { status: 404 });
  return Response.json(doc, { headers: { "cache-control": "max-age=60" } });
}

let dir: string;
let db: Db;
let auth: ReturnType<typeof createAuth>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-test-"));
  const path = join(dir, "test.db");
  runMigrations(path);
  db = openDatabase(path);
  auth = createAuth(db, env, { fetchClientMetadataResource: fakeTransport });
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// --- helpers -------------------------------------------------------------

const call = (path: string, init?: RequestInit) =>
  auth.handler(new Request(new URL(path, BASE), init));

async function signIn(email = "allowed@example.com") {
  const url = new URL("/api/auth/e2e/sign-in", BASE);
  url.searchParams.set("email", email);
  const res = await auth.handler(new Request(url));
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("better-auth.session_token="));
  return cookie?.split(";")[0];
}

async function register(body: Record<string, unknown>) {
  return call("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerClient(): Promise<string> {
  const res = await register({
    client_name: "Test Client",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    application_type: "native",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(params: Record<string, string | undefined>) {
  const url = new URL("/api/auth/oauth2/authorize", BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url;
}

/** Follows a redirect to the client, and returns its query. */
function clientRedirect(location: string | null) {
  expect(location).toBeTruthy();
  const url = new URL(location!, BASE);
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
  return url.searchParams;
}

/** Signs in, authorizes, and approves. Returns the code and the verifier. */
async function getCode(
  clientId: string,
  opts: { scope?: string; cookie?: string } = {},
) {
  const cookie = opts.cookie ?? (await signIn())!;
  const { verifier, challenge } = pkce();
  const res = await auth.handler(
    new Request(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: opts.scope ?? ALL,
        state: "state-1",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { headers: { cookie } },
    ),
  );
  expect(res.status).toBe(302);
  let location = res.headers.get("location")!;
  if (location.startsWith("/oauth/consent")) {
    const consent = await call("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({
        accept: true,
        oauth_query: new URL(location, BASE).search.slice(1),
      }),
    });
    expect(consent.status).toBe(200);
    location = ((await consent.json()) as { url: string }).url;
  }
  const query = clientRedirect(location);
  return { code: query.get("code")!, query, verifier, cookie };
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope: string;
  error?: string;
}

async function token(params: Record<string, string>) {
  const res = await call("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Tokens };
}

async function getTokens(clientId: string, scope?: string) {
  const { code, verifier } = await getCode(clientId, { scope });
  const res = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: clientId,
    resource: RESOURCE,
  });
  expect(res.status).toBe(200);
  return res.body;
}

const mcp = withMcpAuth(
  { auth: () => auth, db: () => db, env },
  async (_req, caller) => {
    requireScopes(caller, [SCOPES.read]);
    return Response.json({ userId: caller.userId, clientId: caller.clientId });
  },
);

const callMcp = (accessToken?: string) =>
  mcp(
    new Request(RESOURCE, {
      method: "POST",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      body: "{}",
    }),
  );

// --- metadata --------------------------------------------------------------

describe("metadata", () => {
  it("serves the authorization server metadata at the root", async () => {
    const res = await call("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
      token_endpoint: `${BASE}/api/auth/oauth2/token`,
      registration_endpoint: `${BASE}/api/auth/oauth2/register`,
      revocation_endpoint: `${BASE}/api/auth/oauth2/revoke`,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
      scopes_supported: ["lists:read", "lists:write", "offline_access"],
    });
    expect(meta.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("serves the protected resource metadata at %s", async (path) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [BASE],
      bearer_methods_supported: ["header"],
      // Not offline_access: refresh tokens are not a resource need.
      scopes_supported: ["lists:read", "lists:write"],
    });
  });
});

// --- registration ----------------------------------------------------------

describe("dynamic client registration", () => {
  it("requires application_type", async () => {
    const res = await register({
      client_name: "No Type",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("registers a native client and links it to /mcp", async () => {
    const res = await register({
      client_name: "Native",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      application_type: "native",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      application_type: "native",
      resources: [RESOURCE],
    });
  });
});

describe("client ID metadata documents", () => {
  it("fetches the document and uses its name and redirect URIs", async () => {
    const { code, verifier } = await getCode(CIMD_ID);
    expect(fetched).toContain(CIMD_ID);
    const row = db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, CIMD_ID))
      .get();
    expect(row).toMatchObject({
      name: "Metadata Client",
      clientDiscoveryId: "cimd",
    });
    const res = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: CIMD_ID,
      resource: RESOURCE,
    });
    expect(res.status).toBe(200);
    expect((await callMcp(res.body.access_token)).status).toBe(200);
  });

  it("rejects a redirect URI that the document does not list", async () => {
    const cookie = await signIn();
    const res = await auth.handler(
      new Request(
        authorizeUrl({
          response_type: "code",
          client_id: CIMD_ID,
          redirect_uri: "https://evil.example/callback",
          scope: ALL,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
        }),
        { headers: { cookie: cookie! } },
      ),
    );
    // Not a redirect to the unknown URI.
    expect(res.headers.get("location") ?? "").not.toContain("evil.example");
  });

  it("rejects a document whose client_id is not its URL", async () => {
    const id = "https://client.test/wrong-id.json";
    const res = await call(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`,
      { headers: { cookie: (await signIn())! } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      db.select().from(oauthClients).where(eq(oauthClients.clientId, id)).get(),
    ).toBeUndefined();
  });

  it.each([
    "https://127.0.0.1/client.json",
    "https://10.0.0.8/client.json",
    "https://[::1]/client.json",
    "https://localhost/client.json",
    "http://client.test/oauth/client.json",
  ])("does not fetch %s (SSRF guard)", async (id) => {
    fetched.length = 0;
    const res = await call(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`,
      { headers: { cookie: (await signIn())! } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fetched).toEqual([]);
  });
});

// --- authorization ---------------------------------------------------------

describe("authorization", () => {
  it("does not authorize an account that is not in the allowlist", async () => {
    // The sign-in itself fails, thus there is no session to authorize with.
    expect(await signIn("other@example.com")).toBeUndefined();
    const clientId = await registerClient();
    const res = await auth.handler(
      new Request(
        authorizeUrl({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: ALL,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
        }),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/sign-in\?/);
  });

  it("puts iss in a successful authorization response", async () => {
    const { query } = await getCode(await registerClient());
    expect(query.get("iss")).toBe(BASE);
    expect(query.get("state")).toBe("state-1");
  });

  it("puts iss in an error response (the user denies)", async () => {
    const clientId = await registerClient();
    const cookie = (await signIn())!;
    const res = await auth.handler(
      new Request(
        authorizeUrl({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: ALL,
          state: "s2",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
        }),
        { headers: { cookie } },
      ),
    );
    const consentUrl = new URL(res.headers.get("location")!, BASE);
    expect(consentUrl.pathname).toBe("/oauth/consent");
    const deny = await call("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({
        accept: false,
        oauth_query: consentUrl.search.slice(1),
      }),
    });
    const query = clientRedirect(((await deny.json()) as { url: string }).url);
    expect(query.get("error")).toBe("access_denied");
    expect(query.get("iss")).toBe(BASE);
  });

  it("requires PKCE, and puts iss in that error", async () => {
    const clientId = await registerClient();
    const res = await auth.handler(
      new Request(
        authorizeUrl({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: ALL,
          resource: RESOURCE,
        }),
        { headers: { cookie: (await signIn())! } },
      ),
    );
    const query = clientRedirect(res.headers.get("location"));
    expect(query.get("error")).toBe("invalid_request");
    expect(query.get("iss")).toBe(BASE);
    expect(query.get("code")).toBeNull();
  });

  it("rejects a code with the wrong PKCE verifier", async () => {
    const clientId = await registerClient();
    const { code } = await getCode(clientId);
    const res = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("requires the resource parameter", async () => {
    const res = await auth.handler(
      new Request(
        authorizeUrl({
          response_type: "code",
          client_id: await registerClient(),
          redirect_uri: REDIRECT,
          scope: ALL,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: (await signIn())! } },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("rejects a resource that is not /mcp", async () => {
    const clientId = await registerClient();
    const { code, verifier } = await getCode(clientId);
    const res = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
      resource: "https://other.example/mcp",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_target");
  });
});

// --- tokens at /mcp ----------------------------------------------------------

function challenge(res: Response) {
  return res.headers.get("www-authenticate") ?? "";
}

describe("/mcp tokens", () => {
  it("binds aud to /mcp and accepts the token", async () => {
    const tokens = await getTokens(await registerClient());
    const [, payload] = tokens.access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ aud: RESOURCE, iss: BASE });
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect((await callMcp(tokens.access_token)).status).toBe(200);
  });

  it("gives 401 with resource_metadata and no error without a token", async () => {
    const res = await callMcp();
    expect(res.status).toBe(401);
    expect(challenge(res)).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge(res)).toContain('scope="lists:read lists:write"');
    expect(challenge(res)).not.toContain("error=");
  });

  it("rejects a token for a different aud", async () => {
    const user = db.select().from(users).get()!;
    const { token: jwt } = await auth.api.signJWT({
      body: {
        payload: {
          sub: user.id,
          aud: "https://other.example/mcp",
          azp: "x",
          scope: ALL,
        },
      },
    });
    const res = await callMcp(jwt);
    expect(res.status).toBe(401);
    expect(challenge(res)).toContain('error="invalid_token"');
  });

  it("rejects a JWT with the right aud that is not an access token", async () => {
    const tokens = await getTokens(await registerClient());
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
    );
    const { token: jwt } = await auth.api.signJWT({
      body: {
        payload: {
          sub: claims.sub,
          aud: RESOURCE,
          azp: claims.azp,
          scope: ALL,
        },
      },
    });
    const res = await callMcp(jwt);
    expect(res.status).toBe(401);
    expect(challenge(res)).toContain('error="invalid_token"');
  });

  it("gives 401 for an expired token", async () => {
    const tokens = await getTokens(await registerClient());
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
    const res = await callMcp(tokens.access_token);
    expect(res.status).toBe(401);
    expect(challenge(res)).toContain('error="invalid_token"');
  });

  it("gives 403 insufficient_scope when a scope is missing", async () => {
    const tokens = await getTokens(await registerClient(), "lists:write");
    expect(tokens.scope).toBe("lists:write");
    const res = await callMcp(tokens.access_token);
    expect(res.status).toBe(403);
    expect(challenge(res)).toContain('error="insufficient_scope"');
    expect(challenge(res)).toContain('scope="lists:read"');
    expect(challenge(res)).toContain("resource_metadata=");
  });

  it("gives 401 after the user leaves the allowlist", async () => {
    const tokens = await getTokens(await registerClient());
    const strict = withMcpAuth(
      { auth: () => auth, db: () => db, env: { ...env, ALLOWED_EMAILS: "" } },
      async () => new Response("ok"),
    );
    const res = await strict(
      new Request(RESOURCE, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});

// --- refresh and revoke ------------------------------------------------------

describe("refresh tokens", () => {
  it("rotates the refresh token, and a replay ends the grant", async () => {
    const clientId = await registerClient();
    const first = await getTokens(clientId);
    expect(first.refresh_token).toBeTruthy();

    const second = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBeTruthy();
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await callMcp(second.body.access_token)).status).toBe(200);

    // After the 30-second retry window, the old token is a replay.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31_000 });
    const replay = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    // The replay revoked the family: the new token stops working too.
    const after = await token({
      grant_type: "refresh_token",
      refresh_token: second.body.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(after.body.error).toBe("invalid_grant");
  });

  it("gives no refresh token without offline_access", async () => {
    const tokens = await getTokens(
      await registerClient(),
      "lists:read lists:write",
    );
    expect(tokens.refresh_token).toBeUndefined();
  });
});

describe("connected apps", () => {
  it("lists an approved app, and a revoke cuts off its access", async () => {
    const clientId = await registerClient();
    const tokens = await getTokens(clientId);
    const user = db
      .select()
      .from(users)
      .where(eq(users.email, "allowed@example.com"))
      .get()!;

    const app = listConnectedApps(db, user.id).find(
      (a) => a.clientId === clientId,
    );
    expect(app).toMatchObject({
      name: "Test Client",
      host: "127.0.0.1:9999",
      scopes: ["lists:read", "lists:write", "offline_access"],
    });
    expect((await callMcp(tokens.access_token)).status).toBe(200);

    expect(revokeConnectedApp(db, user.id, clientId)).toBe(true);
    expect(
      listConnectedApps(db, user.id).some((a) => a.clientId === clientId),
    ).toBe(false);

    // The access token was valid a moment ago. Now it is not.
    const res = await callMcp(tokens.access_token);
    expect(res.status).toBe(401);
    expect(challenge(res)).toContain('error="invalid_token"');
    // And the refresh token does not work.
    const refresh = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refresh.body.error).toBe("invalid_grant");
  });

  it("does not revoke the app of another user", async () => {
    expect(revokeConnectedApp(db, "someone-else", "no-client")).toBe(false);
  });
});
