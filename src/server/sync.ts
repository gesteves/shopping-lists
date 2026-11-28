// The logic of the sync endpoints (#6). The route files in
// src/app/api/sync/ check the session, then call these functions.
import "server-only";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import {
  MAX_PUSH_BYTES,
  pullQuerySchema,
  pushRequestSchema,
  type PullResponse,
  type PushResponse,
} from "@/shared/sync";
import { readJson } from "./json";
import { applyOps, type Actor, type ApplyOptions } from "./ops";
import { readChanges, readSeqState, readUsers } from "./queries";
import { summaryWorkerRunning } from "./summary/worker";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function badRequest(error: z.ZodError): Response {
  return json(
    {
      error: "invalid_request",
      issues: error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
    400,
  );
}

/**
 * POST /api/sync/push. The body is `{ clientId, ops }`. It returns a
 * PushResponse. A bad body gets 400 and nothing is applied: the client checks
 * each op with the same schema before it puts the op in the outbox.
 */
export async function handlePush(
  request: Request,
  actor: Actor,
  options: ApplyOptions = {},
): Promise<Response> {
  const body = await readJson(request, pushRequestSchema, {
    maxBytes: MAX_PUSH_BYTES,
  });
  if (!body.ok) return body.response;

  const result: PushResponse = {
    ...applyOps(actor, "app", body.data.ops, options),
    now: (options.now ?? Date.now)(),
  };
  return json(result);
}

/**
 * GET /api/sync/pull?since=<seq>&limit=<n>. It returns a PullResponse.
 *
 * If the cursor is before the last purge, or after the last seq (the server
 * database is older than the client), the response has `reset: true` and
 * starts again from seq 0. A client that sends `seen` at or after the last
 * purge got that purge in an earlier page: it gets no reset. Thus a reset
 * that needs more than one page completes.
 */
export function handlePull(
  request: Request,
  options: { db?: Db; now?: () => number; summaries?: boolean } = {},
): Response {
  const db = options.db ?? getDb();
  const now = options.now ?? Date.now;
  const url = new URL(request.url);
  const parsed = pullQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!parsed.success) return badRequest(parsed.error);
  const { since, seen, limit } = parsed.data;

  // better-sqlite3 is synchronous, thus no write can come between the reads.
  // The transaction makes this explicit.
  const body = db.transaction((tx): PullResponse => {
    const state = readSeqState(tx);
    const purged =
      since > 0 &&
      since < state.purgedSeq &&
      (seen === undefined || seen < state.purgedSeq);
    const reset = since > state.seq || purged;
    const from = reset ? 0 : since;
    const changes = readChanges(from, limit, tx);
    return {
      reset,
      lists: changes.lists,
      items: changes.items,
      users: readUsers(tx),
      hlc: changes.hlc,
      // After the last page, the cursor is the last seq of the server.
      cursor: changes.hasMore
        ? (changes.lastSeq ?? from)
        : Math.max(changes.lastSeq ?? from, state.seq),
      hasMore: changes.hasMore,
      purgedSeq: state.purgedSeq,
      now: now(),
      summaries: options.summaries ?? summaryWorkerRunning(),
    };
  });
  return json(body);
}
