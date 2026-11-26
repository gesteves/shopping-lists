import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image runs the standalone server (#3).
  output: "standalone",
  // better-sqlite3 is a native module. Do not bundle it.
  serverExternalPackages: ["better-sqlite3"],
  // CLAUDE.md has the agent rules. Do not write AGENTS.md.
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
