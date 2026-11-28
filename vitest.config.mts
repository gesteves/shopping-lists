import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" throws outside the React server build.
      "server-only": fileURLToPath(
        new URL("./src/test/empty.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // No Claude in the tests: no key, also when the shell has one, and no
    // request to an Anthropic host (src/test/no-claude.ts).
    env: { ANTHROPIC_API_KEY: "" },
    setupFiles: ["src/test/no-claude.ts"],
  },
});
