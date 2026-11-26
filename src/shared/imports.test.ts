// The browser and the server both use src/shared. Thus its files can import
// only zod and other shared files: no Node, DOM, React, Next, or database
// code.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src/shared");
const ALLOWED = [/^zod$/, /^\.\/[^/]+$/];
const IMPORT =
  /(?:^|\s)(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

const files = readdirSync(DIR).filter(
  (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
);

describe("src/shared", () => {
  it("has files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["hlc.ts", "ops.ts"]));
  });

  for (const file of files) {
    it(`${file} imports only zod and shared files`, () => {
      const source = readFileSync(join(DIR, file), "utf8");
      const specifiers = [...source.matchAll(IMPORT)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? m[4],
      );
      for (const s of specifiers) {
        expect(
          ALLOWED.some((re) => re.test(s)),
          `${file} imports "${s}"`,
        ).toBe(true);
      }
    });

    it(`${file} uses no browser or Node globals`, () => {
      const source = readFileSync(join(DIR, file), "utf8");
      for (const name of [
        "window",
        "document",
        "localStorage",
        "indexedDB",
        "navigator",
        "process",
        "Buffer",
        "__dirname",
      ]) {
        expect(
          new RegExp(`\\b${name}\\b`).test(source),
          `${file} uses ${name}`,
        ).toBe(false);
      }
    });
  }
});
