// The offline list shell (#103). This file imports nothing.

/**
 * The app caches this page when it is online. The service worker gives it
 * for a list page that is not in the cache. The list page reads the list ID
 * from the URL, thus the shell shows each list.
 */
export const LIST_SHELL_PATH = "/lists/shell";
