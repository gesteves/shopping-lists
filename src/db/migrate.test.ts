import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import { runMigrations } from "./migrate";

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
});
