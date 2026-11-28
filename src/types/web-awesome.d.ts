// JSX types for the <wa-*> tags (#51). Event props have their exact names,
// for example "onwa-hide". Attach wa-* listeners in a callback ref: React
// hydration does not attach them on server-rendered tags.
import type { CustomElements } from "@web.awesome.me/webawesome-pro/dist/custom-elements-jsx.d.ts";

// Each <wa-*> tag has suppressHydrationWarning (an ESLint rule): the
// element sets its own attributes when it upgrades, before React hydrates
// it. The Web Awesome types do not have the prop, thus each tag that the
// app uses is here. Add a new tag here too.
type Hydrated<K extends keyof CustomElements> = CustomElements[K] & {
  suppressHydrationWarning?: boolean;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-avatar": Hydrated<"wa-avatar">;
      "wa-badge": Hydrated<"wa-badge">;
      "wa-button": Hydrated<"wa-button">;
      "wa-callout": Hydrated<"wa-callout">;
      "wa-copy-button": Hydrated<"wa-copy-button">;
      "wa-dialog": Hydrated<"wa-dialog">;
      "wa-divider": Hydrated<"wa-divider">;
      "wa-drawer": Hydrated<"wa-drawer">;
      "wa-dropdown": Hydrated<"wa-dropdown">;
      "wa-dropdown-item": Hydrated<"wa-dropdown-item">;
      "wa-icon": Hydrated<"wa-icon">;
      "wa-input": Hydrated<"wa-input">;
      "wa-number-input": Hydrated<"wa-number-input">;
      "wa-option": Hydrated<"wa-option">;
      "wa-select": Hydrated<"wa-select">;
      "wa-skeleton": Hydrated<"wa-skeleton">;
      "wa-switch": Hydrated<"wa-switch">;
      "wa-textarea": Hydrated<"wa-textarea">;
      "wa-toast": Hydrated<"wa-toast">;
    }
  }
}
