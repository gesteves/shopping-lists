import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 3100);
const baseURL = `http://localhost:${PORT}`;

/** The e2e database. Each run starts with a new one. */
export const E2E_DATABASE_PATH = "./data/e2e.db";

/** The accounts that the e2e tests can sign in with. */
export const E2E_ALLOWED_EMAIL = "allowed@example.com";
/** A second person, for the tests with two users (#11, #12). */
export const E2E_SECOND_EMAIL = "second@example.com";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI uploads the HTML report when a test fails.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 15"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // Test the production build, not the dev server. The server applies the
    // migrations at boot.
    command: `rm -f ${E2E_DATABASE_PATH}* && npm run build && npm run start`,
    env: {
      PORT: String(PORT),
      DATABASE_PATH: E2E_DATABASE_PATH,
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: "e2e-secret-that-is-at-least-32-characters",
      ALLOWED_EMAILS: `${E2E_ALLOWED_EMAIL},${E2E_SECOND_EMAIL}`,
      GOOGLE_CLIENT_ID: "e2e-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-client-secret",
      // Turns on the sign-in stub (src/lib/auth-stub.ts).
      AUTH_STUB: "1",
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
