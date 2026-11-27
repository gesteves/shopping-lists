import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { users } from "@/db/schema";
import { createAuth } from "./auth";
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
  url.searchParams.set("name", "Ana");
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
      name: "Ana",
    });

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie!.split(";")[0] }),
    });
    expect(session?.user.email).toBe("allowed@example.com");
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
