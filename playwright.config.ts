import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 3100);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 15"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // Test the production build, not the dev server.
    command: "npm run build && npm run start",
    env: { PORT: String(PORT) },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
