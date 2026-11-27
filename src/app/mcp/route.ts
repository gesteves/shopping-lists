import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { createMcpRoute } from "@/server/mcp/server";

// The MCP endpoint (#18, #19): stateless Streamable HTTP, spec 2026-07-28,
// and 2025-era clients through the SDK fallback. See "MCP" in docs/PLAN.md.

let route: ((request: Request) => Promise<Response>) | undefined;

export function POST(request: Request) {
  route ??= createMcpRoute({ auth: getAuth, db: getDb });
  return route(request);
}

// No sessions and no standalone SSE stream: POST only.
const notAllowed = () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });
export { notAllowed as GET, notAllowed as DELETE };
