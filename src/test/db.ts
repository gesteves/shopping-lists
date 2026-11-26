// A new database in memory, with all migrations and two users. For tests.
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase, type Db } from "@/db/client";
import { MIGRATIONS_FOLDER } from "@/db/migrate";
import { users } from "@/db/schema";

export const SAM = { id: "user-sam", name: "Sam", email: "sam@example.com" };
export const ALEX = {
  id: "user-alex",
  name: "Alex",
  email: "alex@example.com",
};

export function createTestDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  db.insert(users).values([SAM, ALEX]).run();
  return db;
}
