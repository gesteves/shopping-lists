// Web Awesome setup (#51). It must run before the first component loads:
// web-awesome.ts imports it first.
import { setDefaultIconFamily } from "@web.awesome.me/webawesome-pro/dist/components/icon/library.js";
import { setIconPath } from "@web.awesome.me/webawesome-pro/dist/utilities/base-path.js";
import { registerTranslation } from "@web.awesome.me/webawesome-pro/dist/utilities/localize.js";
import en from "@web.awesome.me/webawesome-pro/dist/translations/en.js";
import { copy } from "@/copy";

// The icons are self-hosted: scripts/build-icons.mjs writes the Font Awesome
// icons that src/app/icons.json lists to public/icons/<style>/<name>.svg.
setIconPath("/icons");
// One style for the whole app. Change it here and in build-icons.mjs.
setDefaultIconFamily("classic", "regular");

// The names of the number input buttons. The e2e tests use them. The
// English type does not list these keys, but the component reads them.
registerTranslation({
  ...en,
  decrement: copy.stepper.decrement,
  increment: copy.stepper.increment,
} as typeof en);
