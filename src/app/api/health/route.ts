import { connection } from "next/server";
import { healthResponse } from "@/server/health";

// No auth. The database and the replication to R2 (src/server/health.ts).
export async function GET() {
  // Do not prerender. The checks must run at each request.
  await connection();
  return healthResponse({ replication: true });
}
