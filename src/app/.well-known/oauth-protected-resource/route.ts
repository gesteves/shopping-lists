import { connection } from "next/server";
import { getAuth } from "@/lib/auth";

// RFC 9728 metadata of the MCP endpoint (#18), at the root and at
// /.well-known/oauth-protected-resource/mcp. The mcp() plugin makes it.
export async function GET(request: Request) {
  // Do not prerender: the document has the URLs of the running server.
  await connection();
  return getAuth().handler(request);
}
