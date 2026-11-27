import type { NextConfig } from "next";

/**
 * Security headers for all routes (#102). No full CSP yet: `frame-ancestors`
 * only, thus no page (for example, the OAuth consent page) can be framed.
 * HSTS has no `includeSubDomains`: other hosts use the zone.
 */
export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), screen-wake-lock=(self)",
  },
];

const nextConfig: NextConfig = {
  // The Docker image runs the standalone server (#3).
  output: "standalone",
  poweredByHeader: false,
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
      { source: "/:path*", headers: SECURITY_HEADERS },
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
