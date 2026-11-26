// The Web Awesome theme CSS, and dark mode with no JavaScript (#51). Web Awesome turns on dark tokens only
// with the .wa-dark class. This step copies each .wa-dark token block of the
// theme into @media (prefers-color-scheme: dark) for :root. Run it again
// after each Web Awesome update: npm run build and npm run dev do it.
// The output is from the Pro theme CSS, thus it is not committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const THEME =
  require.resolve("@web.awesome.me/webawesome-pro/dist/styles/themes/default.css");
const OUT = "src/app/generated/wa-dark.css";
const THEME_OUT = "src/app/generated/wa-theme.css";

/**
 * The theme CSS with each `@import url(...)` put in place. Tailwind does not
 * follow these nested imports, and then the layer order and the color
 * palette are lost.
 */
function inline(file, seen = new Set()) {
  if (seen.has(file)) return "";
  seen.add(file);
  return readFileSync(file, "utf8").replace(
    /@import\s+url\(['"]?([^'")]+)['"]?\)\s*;/g,
    (_, rel) => inline(resolve(dirname(file), rel), seen),
  );
}

const css = readFileSync(THEME, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const declarations = [];
// Rules with no nested blocks: "selectors { declarations }".
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selectors = match[1].split(",").map((s) => s.trim());
  // A dark block lists .wa-dark by itself. Blocks that also list :root
  // already apply to the page.
  if (!selectors.includes(".wa-dark")) continue;
  if (selectors.some((s) => s.includes(":root"))) continue;
  for (const line of match[2].split(";")) {
    const decl = line.trim();
    if (decl) declarations.push(decl);
  }
}
if (!declarations.some((d) => d.startsWith("color-scheme"))) {
  throw new Error(`No .wa-dark block found in ${THEME}`);
}
mkdirSync("src/app/generated", { recursive: true });
writeFileSync(
  THEME_OUT,
  `/* Made by scripts/build-wa-dark.mjs from the Web Awesome theme. Do not edit. */\n${inline(THEME)}\n`,
);
writeFileSync(
  OUT,
  `/* Made by scripts/build-wa-dark.mjs from the Web Awesome theme. Do not edit. */
@layer wa-theme {
  @media (prefers-color-scheme: dark) {
    :where(:root) {
${declarations.map((d) => `      ${d};`).join("\n")}
    }
  }
}
`,
);
console.log(`Wrote ${declarations.length} dark declarations to ${OUT}`);
