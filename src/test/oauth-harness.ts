// A test harness for the OAuth server and /mcp (#18, #19): a temp database,
// the auth instance, the sign-in stub, client registration, and tokens.
// Call it at the top level of a test file: it adds beforeAll and afterAll.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { afterAll, beforeAll, expect } from "vitest";
import { openDatabase, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { createAuth } from "@/lib/auth";

export const BASE = "http://localhost:3000";
export const RESOURCE = `${BASE}/mcp`;
export const REDIRECT = "http://127.0.0.1:9999/callback";
export const ALL_SCOPES = "lists:read lists:write offline_access";

export const ALLOWED = "allowed@example.com";
export const SECOND = "second@example.com";

export const testEnv = {
  AUTH_STUB: "1",
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  ALLOWED_EMAILS: `${ALLOWED},${SECOND}`,
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope: string;
  error?: string;
}

export function setupOAuthHarness(
  options: { fetchClientMetadataResource?: ClientMetadataResourceFetch } = {},
) {
  let dir: string;
  const h = {
    db: undefined as unknown as Db,
    auth: undefined as unknown as ReturnType<typeof createAuth>,

    call(path: string, init?: RequestInit) {
      return h.auth.handler(new Request(new URL(path, BASE), init));
    },

    /** Signs in through the stub. The session cookie, or undefined. */
    async signIn(email = ALLOWED, name = "Ana") {
      const url = new URL("/api/auth/e2e/sign-in", BASE);
      url.searchParams.set("email", email);
      url.searchParams.set("name", name);
      const res = await h.auth.handler(new Request(url));
      const cookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith("better-auth.session_token="));
      return cookie?.split(";")[0];
    },

    register(body: Record<string, unknown>) {
      return h.call("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    async registerClient(name = "Test Client"): Promise<string> {
      const res = await h.register({
        client_name: name,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        application_type: "native",
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { client_id: string }).client_id;
    },

    pkce() {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      return { verifier, challenge };
    },

    authorizeUrl(params: Record<string, string | undefined>) {
      const url = new URL("/api/auth/oauth2/authorize", BASE);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
      return url;
    },

    /** Checks a redirect to the client, and returns its query. */
    clientRedirect(location: string | null) {
      expect(location).toBeTruthy();
      const url = new URL(location!, BASE);
      expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
      return url.searchParams;
    },

    /** Signs in, authorizes, and approves. Returns the code and verifier. */
    async getCode(
      clientId: string,
      opts: { scope?: string; cookie?: string } = {},
    ) {
      const cookie = opts.cookie ?? (await h.signIn())!;
      const { verifier, challenge } = h.pkce();
      const res = await h.auth.handler(
        new Request(
          h.authorizeUrl({
            response_type: "code",
            client_id: clientId,
            redirect_uri: REDIRECT,
            scope: opts.scope ?? ALL_SCOPES,
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
        const consent = await h.call("/api/auth/oauth2/consent", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin: BASE,
          },
          body: JSON.stringify({
            accept: true,
            oauth_query: new URL(location, BASE).search.slice(1),
          }),
        });
        expect(consent.status).toBe(200);
        location = ((await consent.json()) as { url: string }).url;
      }
      const query = h.clientRedirect(location);
      return { code: query.get("code")!, query, verifier, cookie };
    },

    async token(params: Record<string, string>) {
      const res = await h.call("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      });
      return { status: res.status, body: (await res.json()) as Tokens };
    },

    /** A new client, approved by the user of `cookie` (or the first user). */
    async getTokens(
      clientId: string,
      opts: { scope?: string; cookie?: string } = {},
    ) {
      const { code, verifier } = await h.getCode(clientId, opts);
      const res = await h.token({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
      });
      expect(res.status).toBe(200);
      return res.body;
    },
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oauth-test-"));
    const path = join(dir, "test.db");
    runMigrations(path);
    h.db = openDatabase(path);
    h.auth = createAuth(h.db, testEnv, options);
  });

  afterAll(() => {
    h.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return h;
}
