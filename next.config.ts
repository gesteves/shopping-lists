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
  // The service worker (#10): public/sw.js, from scripts/build-sw.mjs. At
  // the root, its scope is the whole app. The Cloudflare cache rule skips
  // /sw.js, and the browser must check it again at each load: no-cache.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
