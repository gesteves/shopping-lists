import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // UI copy lives in the dictionary (src/copy, #66). These rules find
    // text in JSX, and text in the props that show text.
    files: ["src/app/**/*.tsx", "src/client/**/*.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        { noStrings: false, ignoreProps: true },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name=/^(label|placeholder|hint|title|alt|aria-label|confirmLabel)$/] > Literal",
          message: "Put UI text in the dictionary (src/copy).",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    // The service worker build output (scripts/build-sw.mjs).
    "public/sw.js",
  ]),
]);

export default eslintConfig;
