import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { databasePath, openDatabase } from "./client";

export const MIGRATIONS_FOLDER = "./drizzle";

/** Apply all new migrations to the database at `path`. */
export function runMigrations(path: string = databasePath()) {
  const db = openDatabase(path);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  db.$client.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  console.log(`Migrations applied to ${databasePath()}`);
}
