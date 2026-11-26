// The standalone server does not include static files or the migrations.
// Copy them in. The server applies the migrations at boot (src/instrumentation.ts).
import { cpSync, existsSync } from "node:fs";

const out = ".next/standalone";
cpSync(".next/static", `${out}/.next/static`, { recursive: true });
if (existsSync("public"))
  cpSync("public", `${out}/public`, { recursive: true });
cpSync("drizzle", `${out}/drizzle`, { recursive: true });
