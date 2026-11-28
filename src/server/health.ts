// The health checks (#102). No auth.
//   - /api/health/live: the database answers. The Fly service check uses it.
//     A failed service check stops the traffic to the machine, and there is
//     one machine. Thus a backup problem must not fail it.
//   - /api/health: also the replication to R2. The Fly top-level check and
//     the deploy check of CI use it. They do not stop the traffic.
import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { log } from "./log";
import { replicationStatus, type ReplicationStatus } from "./replication";

const NO_STORE = { "Cache-Control": "no-store" };

type Check = "live" | "full";

/** The last state of each check. A check that passes logs nothing. */
const lastDown = new Map<Check, string | null>();

/**
 * Log only a change of state (#147): Fly calls the checks each 15 s and each
 * 60 s. `reason` is null when the check passes.
 */
function track(
  check: Check,
  reason: string | null,
  lag?: number,
  error?: unknown,
) {
  const before = lastDown.get(check) ?? null;
  lastDown.set(check, reason);
  if (reason === before) return;
  if (reason) log.warn("health", "down", { check, reason, lag }, error);
  else log.info("health", "up", { check });
}

/** For tests. */
export function resetHealthState() {
  lastDown.clear();
}

export async function healthResponse(
  options: {
    replication?: boolean;
    db?: Db;
    status?: () => Promise<ReplicationStatus | null>;
  } = {},
): Promise<Response> {
  const check: Check = options.replication ? "full" : "live";
  try {
    (options.db ?? getDb()).get(sql`select 1`);
  } catch (error) {
    track(check, "db", undefined, error);
    return Response.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
  if (!options.replication) {
    track(check, null);
    return Response.json({ ok: true }, { headers: NO_STORE });
  }
  const replication = await (options.status ?? replicationStatus)();
  track(
    check,
    replication && !replication.ok ? replication.reason : null,
    replication && "lagMs" in replication && !replication.ok
      ? replication.lagMs
      : undefined,
  );
  if (replication && !replication.ok) {
    return Response.json(
      { ok: false, replication },
      { status: 503, headers: NO_STORE },
    );
  }
  return Response.json(
    { ok: true, ...(replication && { replication }) },
    { headers: NO_STORE },
  );
}
