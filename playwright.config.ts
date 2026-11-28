import { defineConfig, devices } from "@playwright/test";
import { generateVAPIDKeys } from "web-push";

// New VAPID keys for each run. Pushes in e2e go to fake endpoints.
const vapid = generateVAPIDKeys();

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
  // CI uploads the HTML report when a test fails or is flaky.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Show the slow tests at the end of the run.
  reportSlowTests: { max: 10, threshold: 15_000 },
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    // A test with the tag "@once" does not use a browser in a way that
    // changes the result (for example, it only uses `request`). It runs on
    // desktop only.
    {
      name: "mobile",
      use: { ...devices["iPhone 15"] },
      grepInvert: /@once/,
    },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // Test the production build, not the dev server. The server applies the
    // migrations at boot. E2E_NO_BUILD=1 uses the last build: CI builds in
    // its own step.
    command: [
      `rm -f ${E2E_DATABASE_PATH}*`,
      ...(process.env.E2E_NO_BUILD ? [] : ["npm run build"]),
      "npm run start",
    ].join(" && "),
    env: {
      PORT: String(PORT),
      DATABASE_PATH: E2E_DATABASE_PATH,
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: "e2e-secret-that-is-at-least-32-characters",
      ALLOWED_EMAILS: `${E2E_ALLOWED_EMAIL},${E2E_SECOND_EMAIL}`,
      GOOGLE_CLIENT_ID: "e2e-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-client-secret",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "https://shopping-lists.invalid",
      // Turns on the sign-in stub (src/lib/auth-stub.ts).
      AUTH_STUB: "1",
      // No Claude: the same as CI, also when .env.local has a key (the env
      // wins over the file). Thus no summary worker (#143) and no API calls.
      ANTHROPIC_API_KEY: "",
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
