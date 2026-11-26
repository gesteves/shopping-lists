import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/db/client";

// No auth. The Fly health check and the deploy check (#24) use it.
export async function GET() {
  // Do not prerender. The query must run at each request.
  await connection();
  try {
    getDb().get(sql`select 1`);
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
