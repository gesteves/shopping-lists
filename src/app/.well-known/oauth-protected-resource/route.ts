import { getAuth } from "@/lib/auth";

// RFC 9728 metadata of the MCP endpoint (#18), at the root and at
// /.well-known/oauth-protected-resource/mcp. The mcp() plugin makes it.
export const GET = (request: Request) => getAuth().handler(request);
