import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import { openDatabase } from "./client";
import {
  MIGRATIONS_FOLDER,
  openMigrationConnection,
  runMigrations,
} from "./migrate";

/** A copy of drizzle/ with one more migration, as drizzle-kit writes it. */
function folderWith(dir: string, tag: string, statements: string[]) {
  const folder = join(dir, "drizzle");
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  writeFileSync(
    join(folder, `${tag}.sql`),
    statements.join("--> statement-breakpoint\n"),
  );
  const path = join(folder, "meta", "_journal.json");
  const copy = JSON.parse(readFileSync(path, "utf8")) as typeof journal;
  const last = copy.entries.at(-1)!;
  copy.entries.push({
    ...last,
    idx: last.idx + 1,
    when: last.when + 1000,
    tag,
  });
  writeFileSync(path, JSON.stringify(copy));
  return folder;
}

/** A database with the migrations, one user, one list, and two items. */
function seeded(dir: string) {
  const path = join(dir, "test.db");
  runMigrations(path);
  const sqlite = new Database(path);
  sqlite.exec(`
    INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES ('u1', 'Sam', 'sam@example.com', 1, 0, 0);
    INSERT INTO lists (id, name, created_by, created_at, updated_by, updated_at, clocks, seq)
      VALUES ('l1', 'Target', 'u1', 0, 'u1', 0, '{}', 1);
    INSERT INTO items (id, list_id, name, name_key, created_by, created_at, updated_by, updated_at, clocks, seq)
      VALUES ('i1', 'l1', 'Milk', 'milk', 'u1', 0, 'u1', 0, '{}', 2),
             ('i2', 'l1', 'Eggs', 'eggs', 'u1', 0, 'u1', 0, '{}', 3);
  `);
  sqlite.close();
  return path;
}

describe("runMigrations", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the migrations to a new SQLite file", () => {
    dir = mkdtempSync(join(tmpdir(), "shopping-lists-"));
    const path = join(dir, "nested", "test.db");

    runMigrations(path);
    // A second run must not do anything.
    runMigrations(path);

    const sqlite = new Database(path, { readonly: true });
    const rows = sqlite.prepare("SELECT hash FROM __drizzle_migrations").all();
    const mode = sqlite.pragma("journal_mode", { simple: true });
    sqlite.close();

    expect(rows).toHaveLength(journal.entries.length);
    expect(mode).toBe("wal");
  });

  it("makes every table and the sync indexes", () => {
    dir = mkdtempSync(join(tmpdir(), "shopping-lists-"));
    const path = join(dir, "test.db");
    runMigrations(path);

    const sqlite = new Database(path, { readonly: true });
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name <> 'sqlite_sequence' ORDER BY name",
      )
      .pluck()
      .all();
    /** The columns of each index of a table. */
    const indexes = (table: string) =>
      (
        sqlite.prepare(`PRAGMA index_list(${table})`).all() as {
          name: string;
        }[]
      ).map((i) =>
        (
          sqlite.prepare(`PRAGMA index_info(${i.name})`).all() as {
            name: string;
          }[]
        )
          .map((c) => c.name)
          .join(","),
      );
    const result = {
      tables,
      lists: indexes("lists"),
      items: indexes("items"),
      activity: indexes("activity"),
    };
    sqlite.close();

    expect(result.tables).toEqual([
      "accounts",
      "activity",
      "items",
      "jwks",
      "list_mutes",
      "lists",
      "oauth_access_tokens",
      "oauth_client_assertions",
      "oauth_client_resources",
      "oauth_clients",
      "oauth_consents",
      "oauth_refresh_tokens",
      "oauth_resources",
      "processed_ops",
      "push_subscriptions",
      "server_seq",
      "sessions",
      "users",
      "verifications",
    ]);
    expect(result.lists).toContain("seq");
    expect(result.items).toEqual(
      expect.arrayContaining(["seq", "list_id,name_key", "name_key"]),
    );
    expect(result.activity).toContain("list_id");
  });

  it("keeps server_seq to one row", () => {
    dir = mkdtempSync(join(tmpdir(), "shopping-lists-"));
    const path = join(dir, "test.db");
    runMigrations(path);

    const sqlite = new Database(path);
    const next = sqlite
      .prepare(
        "INSERT INTO server_seq (id, value) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .pluck();
    const values = [next.get(), next.get(), next.get()];
    const insertTwo = () =>
      sqlite.prepare("INSERT INTO server_seq (id, value) VALUES (2, 1)").run();
    expect(insertTwo).toThrow(/CHECK constraint/);
    sqlite.close();

    expect(values).toEqual([1, 2, 3]);
  });

  it("keeps the rows of child tables when a migration rebuilds a table", () => {
    dir = mkdtempSync(join(tmpdir(), "shopping-lists-"));
    const path = seeded(dir);
    // A rebuild of `lists`, as drizzle-kit makes it. Items has
    // ON DELETE cascade to lists.
    const read = new Database(path, { readonly: true });
    const ddl = read
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'lists'")
      .pluck()
      .get() as string;
    read.close();
    const folder = folderWith(dir, "9999_rebuild_lists", [
      "PRAGMA foreign_keys=OFF;",
      ddl.replace("CREATE TABLE `lists`", "CREATE TABLE `__new_lists`") + ";",
      "INSERT INTO `__new_lists` SELECT * FROM `lists`;",
      "DROP TABLE `lists`;",
      "ALTER TABLE `__new_lists` RENAME TO `lists`;",
      "PRAGMA foreign_keys=ON;",
    ]);
    runMigrations(path, folder);

    const sqlite = new Database(path, { readonly: true });
    const count = sqlite.prepare("SELECT count(*) FROM items").pluck().get();
    sqlite.close();
    expect(count).toBe(2);
  });

  it("fails when a migration leaves a row with a bad foreign key", () => {
    dir = mkdtempSync(join(tmpdir(), "shopping-lists-"));
    const path = seeded(dir);
    const folder = folderWith(dir, "9999_orphan", ["DELETE FROM `lists`;"]);
    expect(() => runMigrations(path, folder)).toThrow(/Foreign key check/);
  });

  it("migrates with foreign keys off, and the app keeps them on", () => {
    dir = mkdtempSync(join(tmpdir(), "shopping-lists-"));
    const path = join(dir, "test.db");
    const migration = openMigrationConnection(path);
    const pragmas = (db: Database.Database) => ({
      foreignKeys: db.pragma("foreign_keys", { simple: true }),
      busyTimeout: db.pragma("busy_timeout", { simple: true }),
    });
    expect(pragmas(migration)).toEqual({ foreignKeys: 0, busyTimeout: 5000 });
    migration.close();

    const app = openDatabase(path).$client;
    expect(pragmas(app)).toEqual({ foreignKeys: 1, busyTimeout: 5000 });
    app.close();
  });
});
