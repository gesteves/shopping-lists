// Contract tests of the OAuth server and the token checks of /mcp (#18).
// See "Authorization" and "Verification" in docs/PLAN.md.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthClients, oauthConsents, users } from "@/db/schema";
import { SCOPES } from "@/lib/oauth";
import { listConnectedApps, revokeConnectedApp } from "../connected-apps";
import {
  ALL_SCOPES,
  BASE,
  REDIRECT,
  RESOURCE,
  setupOAuthHarness,
  testEnv,
} from "@/test/oauth-harness";
import { requireScopes, withMcpAuth } from "./auth";

const env = testEnv;

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

const h = setupOAuthHarness({ fetchClientMetadataResource: fakeTransport });
const {
  call,
  signIn,
  register,
  registerClient,
  pkce,
  authorizeUrl,
  clientRedirect,
  getCode,
  token,
} = h;
const getTokens = (clientId: string, scope?: string) =>
  h.getTokens(clientId, { scope });
const ALL = ALL_SCOPES;

afterEach(() => {
  vi.useRealTimers();
});

const mcp = withMcpAuth(
  { auth: () => h.auth, db: () => h.db, env },
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
    const row = h.db
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
    const res = await h.auth.handler(
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
      h.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, id))
        .get(),
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
    const res = await h.auth.handler(
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
    const res = await h.auth.handler(
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
    const res = await h.auth.handler(
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
    const res = await h.auth.handler(
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
    const user = h.db.select().from(users).get()!;
    const { token: jwt } = await h.auth.api.signJWT({
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
    const { token: jwt } = await h.auth.api.signJWT({
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
      {
        auth: () => h.auth,
        db: () => h.db,
        env: { ...env, ALLOWED_EMAILS: "" },
      },
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
    const user = h.db
      .select()
      .from(users)
      .where(eq(users.email, "allowed@example.com"))
      .get()!;

    const app = listConnectedApps(h.db, user.id).find(
      (a) => a.clientId === clientId,
    );
    expect(app).toMatchObject({
      name: "Test Client",
      host: "127.0.0.1:9999",
      scopes: ["lists:read", "lists:write", "offline_access"],
    });
    expect((await callMcp(tokens.access_token)).status).toBe(200);

    expect(revokeConnectedApp(h.db, user.id, clientId)).toBe(true);
    expect(
      listConnectedApps(h.db, user.id).some((a) => a.clientId === clientId),
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

  it("gives 401 to a token from before the last consent", async () => {
    const clientId = await registerClient();
    const old = await getTokens(clientId);
    const user = h.db
      .select()
      .from(users)
      .where(eq(users.email, "allowed@example.com"))
      .get()!;
    revokeConnectedApp(h.db, user.id, clientId);

    // The user connects the same client again, a moment later.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2_000 });
    const fresh = await getTokens(clientId);
    expect((await callMcp(fresh.access_token)).status).toBe(200);
    const res = await callMcp(old.access_token);
    expect(res.status).toBe(401);
    expect(challenge(res)).toContain('error="invalid_token"');
  });

  it("gives only the scopes that are also in the consent", async () => {
    const clientId = await registerClient();
    const tokens = await getTokens(clientId);
    expect((await callMcp(tokens.access_token)).status).toBe(200);
    h.db
      .update(oauthConsents)
      .set({ scopes: JSON.stringify(["lists:write"]) })
      .where(eq(oauthConsents.clientId, clientId))
      .run();
    const res = await callMcp(tokens.access_token);
    expect(res.status).toBe(403);
    expect(challenge(res)).toContain('error="insufficient_scope"');
  });

  it("does not revoke the app of another user", async () => {
    expect(revokeConnectedApp(h.db, "someone-else", "no-client")).toBe(false);
  });
});
