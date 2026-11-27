// Writes src/app/generated/base.css (#56): the base layer of the app.
//
// 1. The Tailwind preflight, but its reset of margin, padding, and border
//    does not apply to Web Awesome tags. A rule on the page wins over the
//    `:host` rule of a component, thus the stock reset removed the padding
//    and the borders of dropdown items, callouts, badges, and toasts.
// 2. Each Web Awesome tag stays hidden until it upgrades (no flash of
//    unstyled components). Not .wa-cloak: it hides the whole page while
//    any custom element is not defined, also the route announcer of Next.js.
//
// The tag names come from custom-elements.json of Web Awesome, thus a new
// component needs no change here. Run it again after each Tailwind or Web
// Awesome update: npm run build and npm run dev do it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const OUT = "src/app/generated/base.css";

const manifest = require("@web.awesome.me/webawesome-pro/dist/custom-elements.json");
const tags = new Set();
for (const mod of manifest.modules) {
  for (const decl of mod.declarations ?? []) {
    if (decl.tagName) tags.add(decl.tagName);
  }
}
if (tags.size === 0) throw new Error("No tags in custom-elements.json");
const list = [...tags].sort().join(",\n    ");

const preflightPath = join(
  dirname(require.resolve("tailwindcss/package.json")),
  "preflight.css",
);
const RESET =
  /^\*,\s*::after,\s*::before,\s*::backdrop,\s*::file-selector-button\s*\{/m;
const preflight = readFileSync(preflightPath, "utf8");
if (!RESET.test(preflight)) {
  throw new Error(`The universal reset is not in ${preflightPath}`);
}
const patched = preflight.replace(
  RESET,
  `:where(:not(\n    ${list}\n  )),\n::after,\n::before,\n::backdrop,\n::file-selector-button {`,
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `/* Made by scripts/build-base-css.mjs. Do not edit. Import it in the base layer. */

/* The Tailwind preflight. The universal reset skips Web Awesome tags. */
${patched}

/* Hide each Web Awesome tag until it upgrades (src/app/web-awesome.ts). */
:where(
    ${list}
  ):not(:defined) {
  visibility: hidden;
}
wa-dialog:not(:defined),
wa-drawer:not(:defined) {
  display: none;
}
`,
);
console.log(`Wrote ${OUT} (${tags.size} Web Awesome tags)`);
