// Contract tests of the MCP endpoint (#19): the transport rules of spec
// 2026-07-28, the legacy path, and every tool. See "MCP" and
// "Verification" in docs/PLAN.md.
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { activity, items, users } from "@/db/schema";
import {
  ALLOWED,
  RESOURCE,
  SECOND,
  setupOAuthHarness,
  testEnv,
} from "@/test/oauth-harness";
import type { PushPayload } from "@/shared/push";
import { bus } from "../bus";
import { Notifier, QUIET_MS } from "../notify/worker";
import { prompts } from "@/prompts";
import { MAX_MCP_BODY_BYTES, UNEXPECTED_ERROR, createMcpRoute } from "./server";
import { TOOLS } from "./tools";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

const h = setupOAuthHarness();
let route: (request: Request) => Promise<Response>;
let token: string;
let readOnlyToken: string;
let userId: string;

beforeAll(async () => {
  route = createMcpRoute({
    auth: () => h.auth,
    db: () => h.db,
    env: testEnv,
  });
  token = (await h.getTokens(await h.registerClient("Claude"))).access_token;
  readOnlyToken = (
    await h.getTokens(await h.registerClient("Reader"), {
      scope: "lists:read",
    })
  ).access_token;
  userId = h.db.select().from(users).get()!.id;
});

// --- raw HTTP --------------------------------------------------------------

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

let nextId = 1;

/** A modern JSON-RPC POST. `headers` and `meta` change the defaults. */
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    headers?: Record<string, string | undefined>;
    meta?: Record<string, unknown>;
    token?: string;
    id?: number | null;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${opts.token ?? token}`,
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  const body = {
    jsonrpc: "2.0",
    ...(opts.id !== null && { id: opts.id ?? nextId++ }),
    method,
    params: { ...params, _meta: { ...META, ...opts.meta } },
  };
  const res = await route(
    new Request(RESOURCE, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

describe("transport", () => {
  it("answers 405 to GET and DELETE", async () => {
    const { GET, DELETE } = await import("@/app/mcp/route");
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });

  it("serves server/discover", async () => {
    const res = await rpc("server/discover");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const result = res.body.result;
    expect(result).toMatchObject({
      resultType: "complete",
      capabilities: { tools: {} },
      instructions: prompts.mcpInstructions,
      ttlMs: 3_600_000,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "shopping-lists" },
      },
    });
    expect(result.supportedVersions).toContain(MODERN);
  });

  it("rejects a protocol version header that does not match _meta", async () => {
    const res = await rpc(
      "tools/list",
      {},
      {
        headers: { "mcp-protocol-version": "2026-01-01" },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32020);
  });

  it("requires Mcp-Method", async () => {
    const res = await rpc(
      "tools/list",
      {},
      {
        headers: { "mcp-method": undefined },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32020);
  });

  it("requires Mcp-Method to match the body", async () => {
    const res = await rpc(
      "tools/list",
      {},
      {
        headers: { "mcp-method": "server/discover" },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32020);
  });

  it("requires Mcp-Name on tools/call", async () => {
    const res = await rpc(
      "tools/call",
      { name: "list_lists", arguments: {} },
      { headers: { "mcp-name": undefined } },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32020);
  });

  it("rejects an unknown protocol version with the supported list", async () => {
    const res = await rpc(
      "tools/list",
      {},
      {
        headers: { "mcp-protocol-version": "1900-01-01" },
        meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32022);
    expect(res.body.error.data.supported).toContain(MODERN);
  });

  it("rejects a request without client capabilities", async () => {
    const res = await rpc(
      "tools/list",
      {},
      {
        meta: { "io.modelcontextprotocol/clientCapabilities": undefined },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });

  it("answers 404 and -32601 to an unknown method", async () => {
    const res = await rpc("prompts/nothing");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32601);
  });

  it("rejects an Origin that is not allowed, and accepts the app origin", async () => {
    const bad = await rpc(
      "tools/list",
      {},
      {
        headers: { origin: "https://evil.example" },
      },
    );
    expect(bad.status).toBe(403);
    const good = await rpc(
      "tools/list",
      {},
      {
        headers: { origin: new URL(RESOURCE).origin },
      },
    );
    expect(good.status).toBe(200);
  });

  it("gives 413 to a body over the limit", async () => {
    const res = await rpc("tools/call", {
      name: "get_list",
      arguments: { list: "x".repeat(MAX_MCP_BODY_BYTES) },
    });
    expect(res.status).toBe(413);
  });

  it("needs a token before anything else", async () => {
    const res = await rpc("server/discover", {}, { token: "nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("tools/list", () => {
  it("lists the tools in a fixed order, the same each time", async () => {
    const first = await rpc("tools/list");
    const second = await rpc("tools/list");
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({
      resultType: "complete",
      ttlMs: 3_600_000,
      cacheScope: "private",
    });
    const names = first.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(TOOLS.map((t) => t.name));
    expect(names).toEqual([
      "list_lists",
      "get_list",
      "search_items",
      "create_list",
      "rename_list",
      "delete_list",
      "add_items",
      "update_item",
      "check_items",
      "uncheck_items",
      "delete_items",
      "move_item",
      "clear_checked",
      "uncheck_all",
    ]);
    expect(second.body.result.tools).toEqual(first.body.result.tools);
  });

  it("gives each tool a title, schemas, and annotations", async () => {
    const { tools } = (await rpc("tools/list")).body.result;
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.outputSchema.type, tool.name).toBe("object");
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
    }
    const byName = Object.fromEntries(
      tools.map((t: { name: string }) => [t.name, t]),
    );
    expect(byName.list_lists.annotations.readOnlyHint).toBe(true);
    for (const name of ["delete_list", "delete_items", "clear_checked"]) {
      expect(byName[name].annotations.destructiveHint, name).toBe(true);
    }
    for (const name of ["add_items", "check_items", "rename_list"]) {
      expect(byName[name].annotations.destructiveHint, name).toBe(false);
    }
    expect(byName.delete_items.annotations.idempotentHint).toBe(true);
    expect(byName.add_items.inputSchema.properties).toHaveProperty(
      "idempotency_key",
    );
  });
});

describe("scopes", () => {
  it("gives 403 insufficient_scope for a write with a read-only token", async () => {
    const res = await rpc(
      "tools/call",
      { name: "create_list", arguments: { name: "Nope" } },
      { token: readOnlyToken },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(res.headers.get("www-authenticate")).toContain(
      'scope="lists:write"',
    );
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("lets a read-only token read", async () => {
    const res = await rpc(
      "tools/call",
      { name: "list_lists", arguments: {} },
      { token: readOnlyToken },
    );
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
  });
});

// --- tools, through the SDK client ------------------------------------------

async function connect(mode: "modern" | "legacy", accessToken = token) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) => route(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client(
    { name: "contract-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: mode === "modern" ? { pin: MODERN } : "legacy",
      },
    },
  );
  await client.connect(transport);
  return client;
}

type Json = Record<string, unknown> & { [k: string]: never };

/** Calls a tool. Checks the result shape, and returns it. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) {
    const tool = TOOLS.find((t) => t.name === name)!;
    // structuredContent matches the outputSchema, and the text is the JSON.
    expect(() => tool.output.parse(result.structuredContent)).not.toThrow();
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
  }
  return result as typeof result & { structuredContent: Json };
}

function errorText(result: { content: unknown }) {
  return (result.content as { type: string; text: string }[])[0].text;
}

describe("tools", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect("modern");
  });

  it("creates a list, adds items, and reads them back", async () => {
    const created = await callTool(client, "create_list", {
      name: "Whole Foods",
    });
    expect(created.structuredContent).toMatchObject({ name: "Whole Foods" });
    const listId = created.structuredContent.list_id as string;

    const added = await callTool(client, "add_items", {
      list: "whole foods",
      items: [{ name: "Milk" }, { name: "Eggs", quantity: 12, notes: "Large" }],
    });
    expect(added.structuredContent).toMatchObject({
      list_id: listId,
      items: [
        { name: "Milk", result: "added" },
        { name: "Eggs", result: "added" },
      ],
    });

    const lists = await callTool(client, "list_lists", {});
    expect(lists.structuredContent.lists).toContainEqual({
      list_id: listId,
      name: "Whole Foods",
      items: 2,
      unchecked: 2,
    });

    const got = await callTool(client, "get_list", { list: listId });
    const eggs = (got.structuredContent.items as Json[]).find(
      (i) => i.name === "Eggs",
    );
    expect(eggs).toMatchObject({
      quantity: 12,
      notes: "Large",
      checked: false,
      added: { by: "Ana" },
      last_changed: { by: "Ana", via_claude: true },
    });
  });

  it("records each change as the user, via MCP, and pokes the app", async () => {
    const pokes: number[] = [];
    const onPoke = ({ seq }: { seq: number }) => pokes.push(seq);
    bus.on("poke", onPoke);
    try {
      await callTool(client, "add_items", {
        list: "Whole Foods",
        items: [{ name: "Bread" }],
      });
    } finally {
      bus.off("poke", onPoke);
    }
    expect(pokes).toHaveLength(1);
    const row = h.db
      .select()
      .from(activity)
      .where(eq(activity.type, "addItem"))
      .all()
      .find((a) => a.snapshot.itemName === "Bread");
    expect(row).toMatchObject({ actorId: userId, via: "mcp" });
  });

  it("does not add a name twice, and unchecks a checked item", async () => {
    await callTool(client, "check_items", {
      list: "Whole Foods",
      items: ["MILK"],
    });
    const again = await callTool(client, "add_items", {
      list: "Whole Foods",
      items: [{ name: "  milk " }],
    });
    expect(again.structuredContent.items).toEqual([
      expect.objectContaining({ name: "Milk", result: "already_on_list" }),
    ]);
    const got = await callTool(client, "get_list", { list: "Whole Foods" });
    const milk = (got.structuredContent.items as Json[]).filter(
      (i) => i.name === "Milk",
    );
    expect(milk).toHaveLength(1);
    expect(milk[0].checked).toBe(false);
  });

  it("checks, unchecks, and finds items", async () => {
    const checked = await callTool(client, "check_items", {
      list: "Whole Foods",
      items: ["Eggs", "Bread"],
    });
    expect(
      (checked.structuredContent.items as Json[]).map((i) => i.checked),
    ).toEqual([true, true]);
    const unchecked = await callTool(client, "get_list", {
      list: "Whole Foods",
      include_checked: false,
    });
    expect(
      (unchecked.structuredContent.items as Json[]).map((i) => i.name),
    ).toEqual(["Milk"]);

    await callTool(client, "uncheck_items", {
      list: "Whole Foods",
      items: ["Bread"],
    });
    const found = await callTool(client, "search_items", { query: "EG" });
    expect(found.structuredContent.items).toEqual([
      expect.objectContaining({
        name: "Eggs",
        list_name: "Whole Foods",
        checked: true,
      }),
    ]);
  });

  it("updates, moves, and deletes items", async () => {
    await callTool(client, "create_list", { name: "Target" });
    const updated = await callTool(client, "update_item", {
      list: "Whole Foods",
      item: "bread",
      name: "Sourdough",
      quantity: 2,
    });
    expect(updated.structuredContent).toMatchObject({
      name: "Sourdough",
      quantity: 2,
    });
    const moved = await callTool(client, "move_item", {
      list: "Whole Foods",
      item: "Sourdough",
      to_list: "target",
    });
    expect(moved.isError).toBeFalsy();
    const target = await callTool(client, "get_list", { list: "Target" });
    expect(
      (target.structuredContent.items as Json[]).map((i) => i.name),
    ).toEqual(["Sourdough"]);

    const deleted = await callTool(client, "delete_items", {
      list: "Target",
      items: ["Sourdough"],
    });
    expect(deleted.structuredContent.deleted).toEqual([
      expect.objectContaining({ name: "Sourdough" }),
    ]);
  });

  it("unchecks all and clears checked items", async () => {
    await callTool(client, "check_items", {
      list: "Whole Foods",
      items: ["Milk", "Eggs"],
    });
    const unchecked = await callTool(client, "uncheck_all", {
      list: "Whole Foods",
    });
    expect(unchecked.structuredContent.changed_items).toBe(2);
    await callTool(client, "check_items", {
      list: "Whole Foods",
      items: ["Eggs"],
    });
    const cleared = await callTool(client, "clear_checked", {
      list: "Whole Foods",
    });
    expect(cleared.structuredContent.changed_items).toBe(1);
    const got = await callTool(client, "get_list", { list: "Whole Foods" });
    expect((got.structuredContent.items as Json[]).map((i) => i.name)).toEqual([
      "Milk",
    ]);
  });

  it("renames and deletes a list", async () => {
    const renamed = await callTool(client, "rename_list", {
      list: "Target",
      name: "Target Run",
    });
    expect(renamed.structuredContent.name).toBe("Target Run");
    const deleted = await callTool(client, "delete_list", {
      list: "target run",
    });
    expect(deleted.structuredContent).toMatchObject({ name: "Target Run" });
    const gone = await callTool(client, "get_list", { list: "Target Run" });
    expect(gone.isError).toBe(true);
  });

  it("makes the same change once for a repeated idempotency_key", async () => {
    const args = {
      list: "Whole Foods",
      items: [{ name: "Apples" }, { name: "Pears" }],
      idempotency_key: "retry-1",
    };
    const first = await callTool(client, "add_items", args);
    const second = await callTool(client, "add_items", args);
    expect(second.structuredContent).toEqual(first.structuredContent);
    const listId = first.structuredContent.list_id as string;
    const apples = h.db
      .select()
      .from(items)
      .where(and(eq(items.listId, listId), eq(items.name, "Apples")))
      .all();
    expect(apples).toHaveLength(1);

    const list1 = await callTool(client, "create_list", {
      name: "Costco",
      idempotency_key: "k",
    });
    const list2 = await callTool(client, "create_list", {
      name: "Costco",
      idempotency_key: "k",
    });
    expect(list2.isError).toBeFalsy();
    expect(list2.structuredContent.list_id).toBe(
      list1.structuredContent.list_id,
    );
  });

  it("makes the change when a key comes again with different arguments", async () => {
    const first = await callTool(client, "add_items", {
      list: "Whole Foods",
      items: [{ name: "Kiwis" }],
      idempotency_key: "same-key",
    });
    const second = await callTool(client, "add_items", {
      list: "Whole Foods",
      items: [{ name: "Mangos" }],
      idempotency_key: "same-key",
    });
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent.items).toEqual([
      expect.objectContaining({ name: "Mangos", result: "added" }),
    ]);
    const listId = first.structuredContent.list_id as string;
    const mangos = h.db
      .select()
      .from(items)
      .where(and(eq(items.listId, listId), eq(items.name, "Mangos")))
      .all();
    expect(mangos).toHaveLength(1);

    const a = await callTool(client, "create_list", {
      name: "Hardware",
      idempotency_key: "list-key",
    });
    const b = await callTool(client, "create_list", {
      name: "Pharmacy",
      idempotency_key: "list-key",
    });
    expect(b.isError).toBeFalsy();
    expect(b.structuredContent.name).toBe("Pharmacy");
    expect(b.structuredContent.list_id).not.toBe(a.structuredContent.list_id);
  });

  it("counts the changed items from the results, also on a retry", async () => {
    await callTool(client, "create_list", { name: "Count Test" });
    await callTool(client, "add_items", {
      list: "Count Test",
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    await callTool(client, "check_items", {
      list: "Count Test",
      items: ["A", "B"],
    });
    const args = { list: "Count Test", idempotency_key: "clear-1" };
    const cleared = await callTool(client, "clear_checked", args);
    expect(cleared.structuredContent.changed_items).toBe(2);
    const again = await callTool(client, "clear_checked", args);
    expect(again.structuredContent.changed_items).toBe(2);

    const deleted = await callTool(client, "delete_list", {
      list: "Count Test",
    });
    expect(deleted.structuredContent.deleted_items).toBe(1);
  });

  it("gives a general message for an unexpected error", async () => {
    const tool = TOOLS.find((t) => t.name === "list_lists")!;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.spyOn(tool, "run").mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: /data/shopping-lists.db");
    });
    try {
      const res = await client.callTool({ name: "list_lists", arguments: {} });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual([{ type: "text", text: UNEXPECTED_ERROR }]);
      expect(JSON.stringify(res)).not.toContain("SQLITE");
      expect(error).toHaveBeenCalled();
    } finally {
      run.mockRestore();
      error.mockRestore();
    }
  });

  describe("business errors", () => {
    it("names the lists when the list is unknown", async () => {
      const res = await callTool(client, "get_list", { list: "Safeway" });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain("No list matches “Safeway”");
      expect(errorText(res)).toContain("“Whole Foods”");
    });

    it("changes nothing when an item is unknown", async () => {
      const res = await callTool(client, "check_items", {
        list: "Whole Foods",
        items: ["Milk", "Caviar"],
      });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain("“Caviar”");
      const got = await callTool(client, "get_list", { list: "Whole Foods" });
      const milk = (got.structuredContent.items as Json[]).find(
        (i) => i.name === "Milk",
      );
      expect(milk?.checked).toBe(false);
    });

    it("refuses a second list with the same name", async () => {
      const res = await callTool(client, "create_list", {
        name: "whole foods",
      });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain("exists");
    });

    it("says that a deleted list was deleted", async () => {
      const made = await callTool(client, "create_list", { name: "Old" });
      const id = made.structuredContent.list_id as string;
      await callTool(client, "delete_list", { list: id });
      const res = await callTool(client, "add_items", {
        list: id,
        items: [{ name: "X" }],
      });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain("was deleted");
    });

    it.each([
      ["get_list", { list: "L".repeat(101) }],
      ["check_items", { list: "Whole Foods", items: ["I".repeat(201)] }],
    ])(
      "refuses a long reference in %s, and does not quote it",
      async (name, args) => {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        expect(errorText(res)).not.toMatch(/LLLLL|IIIII/);
      },
    );

    it("returns schema errors as tool errors", async () => {
      const res = await client.callTool({
        name: "add_items",
        arguments: { list: "Whole Foods", items: [] },
      });
      expect(res.isError).toBe(true);
    });
  });

  it("works for the second person, as that person", async () => {
    const cookie = (await h.signIn(SECOND, "Sam"))!;
    const other = await h.getTokens(await h.registerClient("Sam's Claude"), {
      cookie,
    });
    const samClient = await connect("modern", other.access_token);
    await callTool(samClient, "add_items", {
      list: "Whole Foods",
      items: [{ name: "Butter" }],
    });
    const got = await callTool(client, "get_list", { list: "Whole Foods" });
    expect(
      (got.structuredContent.items as Json[]).find((i) => i.name === "Butter"),
    ).toMatchObject({ added: { by: "Sam" } });
  });
});

describe("legacy clients (2025-11-25)", () => {
  it("initializes, lists the same tools, and calls a tool", async () => {
    const client = await connect("legacy");
    expect(client.getServerVersion()?.name).toBe("shopping-lists");
    expect(client.getInstructions()).toBe(prompts.mcpInstructions);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const lists = await client.callTool({ name: "list_lists", arguments: {} });
    expect(lists.isError).toBeFalsy();
    expect(lists.structuredContent).toHaveProperty("lists");
  });

  it("answers a raw initialize", async () => {
    const res = await route(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LEGACY,
            capabilities: {},
            clientInfo: { name: "old", version: "1" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(LEGACY);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("notifications", () => {
  it("sends the other person one grouped push, via Claude", async () => {
    // Sam must have an account to get the push.
    await h.signIn(SECOND, "Sam");
    // Earlier tests made activity. It is sent and done.
    h.db.update(activity).set({ notifiedAt: new Date() }).run();
    const client = await connect("modern");
    await callTool(client, "create_list", { name: "Trader Joe’s" });
    await callTool(client, "add_items", {
      list: "Trader Joe’s",
      items: [{ name: "Milk" }, { name: "Eggs" }],
    });

    const sent: { userId: string; payload: PushPayload }[] = [];
    const notifier = new Notifier({
      db: h.db,
      allowlist: `${ALLOWED},${SECOND}`,
      now: () => Date.now() + QUIET_MS + 1,
      send: async (to, payload) => {
        sent.push({ userId: to, payload });
      },
    });
    await notifier.tick();
    const sam = h.db.select().from(users).where(eq(users.email, SECOND)).get()!;
    expect(sent).toEqual([
      {
        userId: sam.id,
        payload: expect.objectContaining({
          title: "Trader Joe’s",
          body: expect.stringMatching(/^Ana \(via Claude\) /),
        }),
      },
    ]);
  });
});
