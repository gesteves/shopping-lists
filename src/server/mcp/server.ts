// The MCP server (#19): the official SDK serves spec 2026-07-28 statelessly,
// and 2025-era clients (`initialize`) from the same factory. See "MCP" in
// docs/PLAN.md.
import "server-only";
import {
  createMcpHandler,
  McpServer,
  originValidationResponse,
  requireScopes,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { Db } from "@/db/client";
import type { Auth } from "@/lib/auth";
import { appOrigin, mcpResource } from "@/lib/oauth";
import { prompts } from "@/prompts";
import { withMcpAuth } from "./auth";
import { TOOLS, ToolError, type ToolContext, type ToolDef } from "./tools";

export const SERVER_INFO = { name: "shopping-lists", version: "1.0.0" };

/** AuthInfo.extra: the token owner, from src/server/mcp/auth.ts. */
export interface McpAuthExtra {
  userId: string;
}

function userIdOf(authInfo: AuthInfo | undefined): string {
  const userId = (authInfo?.extra as McpAuthExtra | undefined)?.userId;
  if (!userId) throw new Error("The MCP handler needs a verified user");
  return userId;
}

/** A server for one request and one caller. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: prompts.mcpInstructions,
    cacheHints: {
      // The tool list changes only with a deploy.
      "tools/list": { ttlMs: 60 * 60_000, cacheScope: "private" },
      "server/discover": { ttlMs: 60 * 60_000, cacheScope: "private" },
    },
    // The largest add_items call: 100 items with 3 fields.
    maxToolInputElements: 1000,
  });

  for (const tool of TOOLS) register(server, ctx, tool as ToolDef);
  return server;
}

function register(server: McpServer, ctx: ToolContext, tool: ToolDef) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      outputSchema: tool.output,
      annotations: { ...tool.annotations, openWorldHint: false },
      // 403 insufficient_scope before the tool runs.
      scopeChallenge: requireScopes(tool.scope),
    },
    // The SDK checks the arguments with inputSchema, and the result with
    // outputSchema. The text block has the same JSON, for older clients.
    async (args) => {
      try {
        const out = tool.run(ctx, args);
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        };
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    },
  );
}

/** The HTTP handler. Give it a verified AuthInfo with McpAuthExtra. */
export function createHandler(deps: { db: () => Db }) {
  // The default response mode gives JSON: the tools send no progress
  // notifications, thus no response becomes an SSE stream.
  return createMcpHandler(({ authInfo }) =>
    buildMcpServer({ db: deps.db(), userId: userIdOf(authInfo) }),
  );
}

type Env = Record<string, string | undefined>;

/**
 * The hosts that can send an `Origin` header. A request without `Origin`
 * (a server-side client) passes. The spec says 403 for any other origin.
 */
export function allowedOriginHosts(env: Env = process.env): string[] {
  return [new URL(appOrigin(env)).hostname, "claude.ai", "claude.com"];
}

/**
 * POST /mcp: the Origin check, the token checks (withMcpAuth), then the SDK
 * handler with the caller as AuthInfo.
 */
export function createMcpRoute(deps: {
  auth: () => Auth;
  db: () => Db;
  env?: Env;
}) {
  const env = deps.env ?? process.env;
  const handler = createHandler(deps);
  const guarded = withMcpAuth(deps, (request, caller) => {
    const token =
      request.headers.get("authorization")?.replace(/^\S+\s+/, "") ?? "";
    const authInfo: AuthInfo = {
      token,
      clientId: caller.clientId,
      scopes: [...caller.scopes],
      resource: new URL(mcpResource(env)),
      resourceMetadataUrl: `${appOrigin(env)}/.well-known/oauth-protected-resource/mcp`,
      extra: { userId: caller.userId } satisfies McpAuthExtra,
    };
    return handler.fetch(request, { authInfo });
  });
  return async (request: Request) =>
    originValidationResponse(request, allowedOriginHosts(env)) ??
    guarded(request);
}
