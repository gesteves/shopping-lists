// Start the standalone server for local use and the e2e tests.
// The standalone server changes its folder to `.next/standalone`. Thus make
// DATABASE_PATH absolute first, or a relative path opens a different file.
import { resolve } from "node:path";

process.env.DATABASE_PATH = resolve(
  process.env.DATABASE_PATH || "./data/dev.db",
);
await import("../.next/standalone/server.js");
