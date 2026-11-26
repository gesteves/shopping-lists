// The standalone server does not include static files. Copy them in.
import { cpSync, existsSync } from "node:fs";

const out = ".next/standalone";
cpSync(".next/static", `${out}/.next/static`, { recursive: true });
if (existsSync("public"))
  cpSync("public", `${out}/public`, { recursive: true });
