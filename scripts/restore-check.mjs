// Checks a restored database (#20, scripts/restore-drill.sh): SQLite
// integrity, the applied migrations, and the row counts. It prints no
// names, emails, or other user data. Exit code 1 if a check fails.
import { createRequire } from "node:module";

// In the image, the app is in /app. APP_DIR is for a local run.
const require = createRequire(`${process.env.APP_DIR ?? "/app"}/`);
const Database = require("better-sqlite3");

const path = process.argv[2];
const db = new Database(path, { readonly: true, fileMustExist: true });
let ok = true;

const integrity = db.pragma("integrity_check", { simple: true });
console.log(`integrity_check: ${integrity}`);
if (integrity !== "ok") ok = false;

const migrations = db
  .prepare(
    "select count(*) as n, max(created_at) as last from __drizzle_migrations",
  )
  .get();
console.log(
  `migrations: ${migrations.n}, last at ${new Date(Number(migrations.last)).toISOString()}`,
);

for (const table of ["users", "lists", "items", "activity", "oauth_clients"]) {
  try {
    const { n } = db.prepare(`select count(*) as n from ${table}`).get();
    console.log(`${table}: ${n} rows`);
  } catch (error) {
    console.log(`${table}: ${error.message}`);
    ok = false;
  }
}
const last = db
  .prepare(
    "select max(updated_at) as t from (select updated_at from lists union all select updated_at from items)",
  )
  .get();
if (last.t) console.log(`newest change: ${new Date(last.t).toISOString()}`);

db.close();
console.log(ok ? "RESTORE OK" : "RESTORE FAILED");
process.exit(ok ? 0 : 1);
