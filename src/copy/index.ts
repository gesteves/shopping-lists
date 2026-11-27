// The UI copy (#66). Import `copy` for all the text that the app shows.
// Server and client components, the service worker, and the e2e tests use
// the same module. It is a static import: no request-time work.
//
// One locale for now. To add one: add a file like en.ts with the type
// `Dictionary`, and add it to `dictionaries`. Components do not change.
import { en } from "./en";

export type Dictionary = typeof en;

const dictionaries = { en } satisfies Record<string, Dictionary>;

export type Locale = keyof typeof dictionaries;

/** The locale of the UI, for `Intl` formats and `<html lang>`. */
export const locale: Locale = "en";

export const copy: Dictionary = dictionaries[locale];
