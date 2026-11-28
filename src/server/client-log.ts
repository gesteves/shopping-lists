// POST /api/client-log (#147): one warn line for each browser error. The
// route checks the session first.
import "server-only";
import {
  MAX_CLIENT_LOG_BYTES,
  cleanMessage,
  cleanPage,
  clientLogSchema,
} from "@/shared/client-log";
import { readJson } from "./json";
import { log } from "./log";

/** The most lines for each user in one minute. */
export const MAX_CLIENT_LOGS_PER_MINUTE = 20;

const windows = new Map<string, { start: number; count: number }>();

/** For tests. */
export function resetClientLogLimits() {
  windows.clear();
}

export async function handleClientLog(
  request: Request,
  userId: string,
  options: { now?: () => number } = {},
): Promise<Response> {
  const body = await readJson(request, clientLogSchema, {
    maxBytes: MAX_CLIENT_LOG_BYTES,
  });
  if (!body.ok) return body.response;

  const now = (options.now ?? Date.now)();
  const window = windows.get(userId);
  if (!window || now - window.start >= 60_000) {
    windows.set(userId, { start: now, count: 1 });
  } else if (++window.count > MAX_CLIENT_LOGS_PER_MINUTE) {
    log.debug("client", "dropped", { user: userId, area: body.data.area });
    return new Response(null, { status: 204 });
  }

  // Clean again: never trust the client.
  const { area, name, msg, status, digest, page } = body.data;
  log.warn("client", "error", {
    area,
    err: name,
    msg: cleanMessage(msg),
    status,
    digest,
    page: cleanPage(page),
    user: userId,
  });
  return new Response(null, { status: 204 });
}
