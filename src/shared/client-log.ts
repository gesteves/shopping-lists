// A browser error, sent to the server log (#147). The client and the
// server both clean the message: no user text may get to the log.
import { z } from "zod";

export const CLIENT_LOG_AREAS = [
  "sync",
  "realtime",
  "unhandled",
  "render",
  "sign-out",
  "recreate",
  "add",
] as const;

export type ClientLogArea = (typeof CLIENT_LOG_AREAS)[number];

export const CLIENT_MSG_MAX = 200;
export const MAX_CLIENT_LOG_BYTES = 2048;

export const clientLogSchema = z
  .object({
    area: z.enum(CLIENT_LOG_AREAS),
    name: z.string().max(60),
    msg: z.string().max(CLIENT_MSG_MAX),
    status: z.number().int().min(100).max(599).optional(),
    digest: z.string().max(40).optional(),
    page: z.string().max(200),
  })
  .strict();

export type ClientLog = z.infer<typeof clientLogSchema>;

/**
 * The message with each quoted text and each URL replaced, cut to
 * CLIENT_MSG_MAX. Names in our messages are in quotes. Thus a name does not
 * get to the log.
 */
export function cleanMessage(text: string): string {
  const clean = text
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|«[^»]*»/g, '"…"')
    // A URL can be the link of an item.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > CLIENT_MSG_MAX
    ? `${clean.slice(0, CLIENT_MSG_MAX - 1)}…`
    : clean;
}

/** The path only: no query and no hash. */
export function cleanPage(page: string): string {
  return page.split(/[?#]/)[0] || "/";
}
