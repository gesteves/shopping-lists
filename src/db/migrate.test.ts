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
});
