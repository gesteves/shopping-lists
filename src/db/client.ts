import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const DEFAULT_DATABASE_PATH = "./data/dev.db";

export function databasePath(): string {
  return process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
}

/** Open a SQLite file and make its folder if it is missing. */
export function openDatabase(path: string = databasePath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL is necessary for Litestream (#3).
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDatabase>;

let db: Db | undefined;

/** The shared connection for the server process. */
export function getDb(): Db {
  db ??= openDatabase();
  return db;
}
