import { connection } from "next/server";
import { healthResponse } from "@/server/health";

// No auth. Only the database (src/server/health.ts). The Fly service check
// uses it.
export async function GET() {
  // Do not prerender. The query must run at each request.
  await connection();
  return healthResponse();
}
