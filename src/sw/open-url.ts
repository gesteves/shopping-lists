// The notification tap (#15): show the page of the notification. It is a
// separate file so that it can be tested outside the worker.

/** The parts of a WindowClient that this file uses. */
export interface WindowLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

export interface ClientsLike {
  matchAll(options: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * A safe same-origin URL from the payload. Anything else, or a missing URL,
 * gives the home page.
 */
export function targetUrl(raw: unknown, origin: string): string {
  if (typeof raw !== "string") return `${origin}/`;
  try {
    const url = new URL(raw, origin);
    return url.origin === origin ? url.href : `${origin}/`;
  } catch {
    return `${origin}/`;
  }
}

/** Use an open window of the app if there is one, or open a new one. */
export async function openUrl(
  clients: ClientsLike,
  url: string,
): Promise<void> {
  const windows = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const same = windows.find((w) => w.url === url);
  if (same) {
    await same.focus();
    return;
  }
  const any = windows[0];
  if (any) {
    await any.focus();
    await any.navigate(url).catch(() => clients.openWindow(url));
    return;
  }
  await clients.openWindow(url);
}
