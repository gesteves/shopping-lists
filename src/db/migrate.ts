import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { databasePath, openDatabase } from "./client";

export const MIGRATIONS_FOLDER = "./drizzle";

/**
 * The connection for the migrations: as openDatabase(), but with
 * `foreign_keys = OFF`. drizzle-kit rebuilds a table (new table, copy, drop,
 * rename) in the transaction of the migration, where `PRAGMA foreign_keys`
 * has no effect. With the keys on, the drop deletes the child rows through
 * `ON DELETE cascade`.
 */
export function openMigrationConnection(path: string): Database.Database {
  const sqlite = openDatabase(path).$client;
  sqlite.pragma("foreign_keys = OFF");
  return sqlite;
}

/** The number of applied migrations. */
function appliedCount(sqlite: Database.Database): number {
  const table = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  if (!table) return 0;
  return sqlite
    .prepare("SELECT count(*) FROM __drizzle_migrations")
    .pluck()
    .get() as number;
}

/**
 * Apply all new migrations to the database at `path`, and give the number
 * that it applied. If it applied a migration, it then checks the foreign
 * keys, and throws if a row points to no row. Then the server does not start.
 */
export function runMigrations(
  path: string = databasePath(),
  folder: string = MIGRATIONS_FOLDER,
): number {
  const sqlite = openMigrationConnection(path);
  try {
    const before = appliedCount(sqlite);
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    const applied = appliedCount(sqlite) - before;
    if (applied === 0) return 0;
    const broken = sqlite.pragma("foreign_key_check") as unknown[];
    if (broken.length > 0) {
      throw new Error(
        `Foreign key check failed after the migrations: ${JSON.stringify(broken.slice(0, 10))}`,
      );
    }
    return applied;
  } finally {
    sqlite.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const applied = runMigrations();
  console.log(`${applied} migrations applied to ${databasePath()}`);
}
