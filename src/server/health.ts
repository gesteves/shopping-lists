// The health checks (#102). No auth.
//   - /api/health/live: the database answers. The Fly service check uses it.
//     A failed service check stops the traffic to the machine, and there is
//     one machine. Thus a backup problem must not fail it.
//   - /api/health: also the replication to R2. The Fly top-level check and
//     the deploy check of CI use it. They do not stop the traffic.
import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { replicationStatus, type ReplicationStatus } from "./replication";

const NO_STORE = { "Cache-Control": "no-store" };

export async function healthResponse(
  options: {
    replication?: boolean;
    db?: Db;
    status?: () => Promise<ReplicationStatus | null>;
  } = {},
): Promise<Response> {
  try {
    (options.db ?? getDb()).get(sql`select 1`);
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
  if (!options.replication) {
    return Response.json({ ok: true }, { headers: NO_STORE });
  }
  const replication = await (options.status ?? replicationStatus)();
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
