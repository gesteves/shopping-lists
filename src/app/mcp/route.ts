import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { SCOPES } from "@/lib/oauth";
import { requireScopes, withMcpAuth } from "@/server/mcp/auth";

// The MCP endpoint (spec 2026-07-28). This ticket (#18) adds only the token
// checks. The JSON-RPC handler and the tools come in #19.

export const POST = withMcpAuth(
  { auth: getAuth, db: getDb },
  async (request, caller) => {
    requireScopes(caller, [SCOPES.read]);
    const body: unknown = await request.json().catch(() => null);
    const id =
      body && typeof body === "object" && "id" in body ? body.id : null;
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  },
);

// Stateless Streamable HTTP: POST only.
const notAllowed = () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });
export { notAllowed as GET, notAllowed as DELETE };
