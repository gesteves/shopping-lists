import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { users } from "@/db/schema";
import { DISABLED_PATHS, createAuth } from "./auth";
import { EMAIL_NOT_ALLOWED } from "./auth-errors";
import { authStubEnabled } from "./auth-stub";

const BASE = "http://localhost:3000";

function testEnv(overrides: Record<string, string> = {}) {
  return {
    AUTH_STUB: "1",
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    ALLOWED_EMAILS: "allowed@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...overrides,
  };
}

function stubSignIn(auth: ReturnType<typeof createAuth>, email: string) {
  const url = new URL("/api/auth/e2e/sign-in", BASE);
  url.searchParams.set("email", email);
  url.searchParams.set("name", "Emily");
  return auth.handler(new Request(url));
}

describe("authStubEnabled", () => {
  const on = {
    AUTH_STUB: "1",
    BETTER_AUTH_URL: "http://localhost:3100",
    NODE_ENV: "production",
  };

  it("is on only with AUTH_STUB=1 and a loopback http URL", () => {
    expect(authStubEnabled(on)).toBe(true);
    expect(
      authStubEnabled({ ...on, BETTER_AUTH_URL: "http://127.0.0.1:3100" }),
    ).toBe(true);
  });

  it.each([
    ["AUTH_STUB is missing", { AUTH_STUB: undefined }],
    ["AUTH_STUB is not 1", { AUTH_STUB: "true" }],
    ["the URL is https", { BETTER_AUTH_URL: "https://localhost:3100" }],
    ["the host is public", { BETTER_AUTH_URL: "http://example.com" }],
    ["the URL is missing", { BETTER_AUTH_URL: undefined }],
    ["the URL is not valid", { BETTER_AUTH_URL: "localhost" }],
    ["the server is on Fly", { FLY_APP_NAME: "app" }],
  ])("is off when %s", (_, change) => {
    expect(authStubEnabled({ ...on, ...change })).toBe(false);
  });
});

describe("sign-in", () => {
  let dir: string;
  let db: Db;
  let env: ReturnType<typeof testEnv>;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-test-"));
    const path = join(dir, "test.db");
    runMigrations(path);
    db = openDatabase(path);
    env = testEnv();
    auth = createAuth(db, env);
  });

  afterAll(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an account that is not in the allowlist, with no user row", async () => {
    const res = await stubSignIn(auth, "other@example.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/sign-in?error=${EMAIL_NOT_ALLOWED}`,
    );
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(db.select().from(users).all()).toEqual([]);
  });

  it("signs in an allowlisted account with a rolling 180-day cookie", async () => {
    const res = await stubSignIn(auth, "Allowed@Example.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("better-auth.session_token="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=15552000/);

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "allowed@example.com",
      name: "Emily",
    });

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie!.split(";")[0] }),
    });
    expect(session?.user.email).toBe("allowed@example.com");
  });

  it("logs a refusal and a sign-in with no email (#147)", async () => {
    const { captureLogs } = await import("@/test/logs");
    const logs = captureLogs();
    try {
      await stubSignIn(auth, "other@example.com");
      await stubSignIn(auth, "allowed@example.com");
      const userId = db.select().from(users).get()!.id;
      expect(logs.lines).toEqual(
        expect.arrayContaining([
          "warn [auth] refused reason=email_not_allowed",
          `info [auth] sign-in user=${userId}`,
        ]),
      );
      expect(logs.text()).not.toContain("@example.com");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects a known user who is no longer in the allowlist", async () => {
    env.ALLOWED_EMAILS = "";
    try {
      const res = await stubSignIn(auth, "allowed@example.com");
      expect(res.headers.get("location")).toBe(
        `/sign-in?error=${EMAIL_NOT_ALLOWED}`,
      );
      expect(res.headers.getSetCookie()).toEqual([]);
    } finally {
      env.ALLOWED_EMAILS = "allowed@example.com";
    }
  });

  it("refuses the session of a removed user, except for sign-in and get-session", async () => {
    const res = await stubSignIn(auth, "allowed@example.com");
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("better-auth.session_token="))!
      .split(";")[0];
    const call = (path: string, init: RequestInit = {}) =>
      auth.handler(
        new Request(new URL(path, BASE), {
          ...init,
          headers: {
            cookie,
            origin: BASE,
            "content-type": "application/json",
          },
        }),
      );
    const consent = () =>
      call("/api/auth/oauth2/consent", {
        method: "POST",
        body: JSON.stringify({ accept: true, oauth_query: "" }),
      });
    const authorize = () =>
      call("/api/auth/oauth2/authorize?client_id=x&resource=x");

    // An allowed user gets past the rule (the request itself is not valid).
    expect((await consent()).status).not.toBe(403);
    expect((await authorize()).status).not.toBe(403);

    env.ALLOWED_EMAILS = "";
    try {
      for (const res of [await consent(), await authorize()]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: EMAIL_NOT_ALLOWED });
      }
      const session = await call("/api/auth/get-session");
      expect(session.status).toBe(200);
      expect((await session.json())?.user.email).toBe("allowed@example.com");
      // The sign-in flow works: Google (here the stub) refuses the account.
      const again = await stubSignIn(auth, "allowed@example.com");
      expect(again.headers.get("location")).toBe(
        `/sign-in?error=${EMAIL_NOT_ALLOWED}`,
      );
      const social = await call("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({ provider: "google" }),
      });
      expect(social.status).toBe(200);
      const callback = await call("/api/auth/callback/google?state=x");
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).not.toContain(EMAIL_NOT_ALLOWED);
      const out = await call("/api/auth/sign-out", { method: "POST" });
      expect(out.status).toBe(200);
    } finally {
      env.ALLOWED_EMAILS = "allowed@example.com";
    }
  });

  it.each([
    "/update-user",
    "/update-session",
    "/delete-user",
    "/change-email",
    "/link-social",
    "/unlink-account",
    "/list-accounts",
    "/list-sessions",
    "/oauth2/create-client",
    "/oauth2/get-clients",
    "/oauth2/update-consent",
  ])("gives 404 for %s", async (path) => {
    expect(DISABLED_PATHS).toContain(path);
    const cookie = (await stubSignIn(auth, "allowed@example.com")).headers
      .getSetCookie()
      .find((c) => c.startsWith("better-auth.session_token="))!
      .split(";")[0];
    const res = await auth.handler(
      new Request(new URL(`/api/auth${path}`, BASE), {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ name: "Mallory", image: "https://x.test/a" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(db.select().from(users).get()?.name).toBe("Emily");
  });

  it("keeps the endpoints of the sign-in and OAuth flows", () => {
    for (const path of [
      "/sign-in/social",
      "/get-session",
      "/sign-out",
      "/oauth2/authorize",
      "/oauth2/consent",
      "/oauth2/continue",
      "/oauth2/token",
      "/oauth2/register",
      "/oauth2/revoke",
      "/oauth2/introspect",
      "/oauth2/public-client",
    ]) {
      expect(DISABLED_PATHS).not.toContain(path);
    }
  });

  it("has no stub endpoint when the stub is off", async () => {
    const off = createAuth(db, testEnv({ AUTH_STUB: "0" }));
    const res = await stubSignIn(off, "allowed@example.com");
    expect(res.status).toBe(404);
  });

  it("turns off the rate limit only with the stub", async () => {
    // All the e2e requests come from one IP.
    const ctx = await auth.$context;
    expect(ctx.rateLimit.enabled).toBe(false);
    expect(ctx.options.rateLimit).toEqual({ enabled: false });
    const off = createAuth(db, testEnv({ AUTH_STUB: "0" }));
    expect((await off.$context).options.rateLimit).toBeUndefined();
  });

  it("uses Secure cookies on an https URL", async () => {
    const https = createAuth(
      db,
      testEnv({ BETTER_AUTH_URL: "https://lists.example.com" }),
    );
    const ctx = await https.$context;
    expect(ctx.authCookies.sessionToken.attributes.secure).toBe(true);
  });
});
