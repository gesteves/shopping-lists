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
import { log } from "../log";
import { isLoggedRefusal, withMcpAuth } from "./auth";
import { TOOLS, ToolError, type ToolContext, type ToolDef } from "./tools";

export const SERVER_INFO = { name: "shopping-lists", version: "1.0.0" };

/** The text of an unexpected error. The model can try again. */
export const UNEXPECTED_ERROR =
  "The server had an unexpected error. Try again later.";

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
      const started = performance.now();
      // One line for each tool call (#147). Never the arguments or the
      // output: they have names.
      const fields = () => ({
        tool: tool.name,
        user: ctx.userId,
        client: ctx.clientId,
        ms: Math.round(performance.now() - started),
      });
      try {
        const out = tool.run(ctx, args);
        log.info("mcp", "call", { ...fields(), result: "ok" });
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        };
      } catch (error) {
        if (error instanceof ToolError) {
          // The message quotes list and item names: not in the log.
          log.info("mcp", "call", { ...fields(), result: "tool_error" });
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
          };
        }
        // Not a business error: keep the detail in the log only. The
        // message can tell about the database or the code.
        log.error("mcp", "call", { ...fields(), result: "error" }, error);
        return {
          content: [{ type: "text", text: UNEXPECTED_ERROR }],
          isError: true,
        };
      }
    },
  );
}

/**
 * The largest request body, in bytes. The SDK default is 4 MiB. The largest
 * call (add_items with 100 items of normal text at the name and notes
 * limits) is less than 1 MiB.
 */
export const MAX_MCP_BODY_BYTES = 1_048_576;

/** The HTTP handler. Give it a verified AuthInfo with McpAuthExtra. */
export function createHandler(deps: { db: () => Db }) {
  // The default response mode gives JSON: the tools send no progress
  // notifications, thus no response becomes an SSE stream.
  return createMcpHandler(
    ({ authInfo }) =>
      buildMcpServer({
        db: deps.db(),
        userId: userIdOf(authInfo),
        clientId: authInfo?.clientId,
      }),
    { maxRequestBodySize: MAX_MCP_BODY_BYTES },
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
  return async (request: Request) => {
    const refused = originValidationResponse(request, allowedOriginHosts(env));
    if (refused) {
      log.warn("mcp", "refused", { status: refused.status, reason: "origin" });
      return refused;
    }
    const response = await guarded(request);
    if (response.status === 401 && !isLoggedRefusal(response)) {
      // A missing, expired, or bad token. An expired token is routine: the
      // client refreshes it.
      log.debug("mcp", "refused", { status: 401, reason: "token" });
    } else if (response.status === 403) {
      log.warn("mcp", "refused", { status: 403, reason: "insufficient_scope" });
    }
    return response;
  };
}
