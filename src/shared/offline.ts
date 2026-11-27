// The offline list shell (#103). This file imports nothing.

/**
 * The app caches this page when it is online. The service worker gives it
 * for a list page that is not in the cache. The list page reads the list ID
 * from the URL, thus the shell shows each list.
 */
export const LIST_SHELL_PATH = "/lists/shell";

/**
 * The message that the sign-out sends to the service worker: delete the
 * cached pages, and do not cache a fetch that started before it (#119).
 */
export const CLEAR_PAGES_MESSAGE = "CLEAR_PAGES";
