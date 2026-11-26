// Writes the Font Awesome icons that the UI uses to public/icons (#51), from
// the icon packages. The Pro SVGs are licensed: never commit them, thus
// public/icons is in .gitignore. The app loads them from its own origin, so
// they work offline (the service worker precaches them).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PACKAGES = {
  regular: "@fortawesome/pro-regular-svg-icons",
  brands: "@fortawesome/free-brands-svg-icons",
};
const OUT = "public/icons";

/** "chevron-left" → "faChevronLeft" */
const exportName = (name) =>
  "fa" + name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

const wanted = JSON.parse(readFileSync("src/app/icons.json", "utf8"));
rmSync(OUT, { recursive: true, force: true });
let count = 0;
for (const [family, pkg] of Object.entries(PACKAGES)) {
  const icons = require(pkg);
  mkdirSync(`${OUT}/${family}`, { recursive: true });
  for (const name of wanted[family] ?? []) {
    const def = icons[exportName(name)];
    if (!def) throw new Error(`No icon "${name}" in ${pkg}`);
    const [width, height, , , path] = def.icon;
    const d = Array.isArray(path) ? path.join(" ") : path;
    writeFileSync(
      `${OUT}/${family}/${name}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path fill="currentColor" d="${d}"/></svg>\n`,
    );
    count++;
  }
}
console.log(`Wrote ${count} icons to ${OUT}`);
