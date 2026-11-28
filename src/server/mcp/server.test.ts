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
      "get_history",
      "create_list",
      "rename_list",
      "set_list_private",
      "delete_list",
      "restore_list",
      "add_items",
      "update_item",
      "check_items",
      "uncheck_items",
      "delete_items",
      "restore_items",
      "move_items",
      "copy_items",
      "clear_checked",
      "uncheck_all",
      "check_all",
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
    expect(byName.get_history.annotations.readOnlyHint).toBe(true);
    for (const name of ["delete_list", "delete_items", "clear_checked"]) {
      expect(byName[name].annotations.destructiveHint, name).toBe(true);
    }
    for (const name of [
      "add_items",
      "check_items",
      "rename_list",
      "restore_list",
      "restore_items",
      "move_items",
      "copy_items",
      "check_all",
    ]) {
      expect(byName[name].annotations.destructiveHint, name).toBe(false);
    }
    for (const name of [
      "restore_list",
      "restore_items",
      "move_items",
      "check_all",
    ]) {
      expect(byName[name].annotations.idempotentHint, name).toBe(true);
    }
    expect(byName.copy_items.annotations.idempotentHint).toBe(false);
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
      name: "Pierre’s General Store",
    });
    expect(created.structuredContent).toMatchObject({
      name: "Pierre’s General Store",
    });
    const listId = created.structuredContent.list_id as string;

    const added = await callTool(client, "add_items", {
      list: "pierre’s general store",
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
      name: "Pierre’s General Store",
      private: false,
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
      added: { by: "Emily" },
      last_changed: { by: "Emily", via_claude: true },
    });
  });

  it("records each change as the user, via MCP, and pokes the app", async () => {
    const pokes: number[] = [];
    const onPoke = ({ seq }: { seq: number }) => pokes.push(seq);
    bus.on("poke", onPoke);
    try {
      await callTool(client, "add_items", {
        list: "Pierre’s General Store",
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
      list: "Pierre’s General Store",
      items: ["MILK"],
    });
    const again = await callTool(client, "add_items", {
      list: "Pierre’s General Store",
      items: [{ name: "  milk " }],
    });
    expect(again.structuredContent.items).toEqual([
      expect.objectContaining({ name: "Milk", result: "already_on_list" }),
    ]);
    const got = await callTool(client, "get_list", {
      list: "Pierre’s General Store",
    });
    const milk = (got.structuredContent.items as Json[]).filter(
      (i) => i.name === "Milk",
    );
    expect(milk).toHaveLength(1);
    expect(milk[0].checked).toBe(false);
  });

  it("checks, unchecks, and finds items", async () => {
    const checked = await callTool(client, "check_items", {
      list: "Pierre’s General Store",
      items: ["Eggs", "Bread"],
    });
    expect(
      (checked.structuredContent.items as Json[]).map((i) => i.checked),
    ).toEqual([true, true]);
    const unchecked = await callTool(client, "get_list", {
      list: "Pierre’s General Store",
      include_checked: false,
    });
    expect(
      (unchecked.structuredContent.items as Json[]).map((i) => i.name),
    ).toEqual(["Milk"]);

    await callTool(client, "uncheck_items", {
      list: "Pierre’s General Store",
      items: ["Bread"],
    });
    const found = await callTool(client, "search_items", { query: "EG" });
    expect(found.structuredContent.items).toEqual([
      expect.objectContaining({
        name: "Eggs",
        list_name: "Pierre’s General Store",
        checked: true,
      }),
    ]);
  });

  it("tells when each item was checked and unchecked (#150)", async () => {
    await callTool(client, "create_list", { name: "Pantry #150" });
    await callTool(client, "create_list", { name: "Freezer #150" });
    await callTool(client, "add_items", {
      list: "Pantry #150",
      items: [{ name: "Rice" }, { name: "Beans" }, { name: "Oats" }],
    });
    const byName = async () => {
      const got = await callTool(client, "get_list", { list: "Pantry #150" });
      return Object.fromEntries(
        (got.structuredContent.items as Json[]).map((i) => [i.name, i]),
      );
    };
    const isNow = (value: unknown, from: number) => {
      const ms = Date.parse(value as string);
      expect(ms).toBeGreaterThanOrEqual(from);
      expect(ms).toBeLessThanOrEqual(Date.now());
    };

    // Never checked: no times.
    expect(await byName()).toMatchObject({
      Oats: { checked_at: null, unchecked_at: null },
    });

    const checkedFrom = Date.now();
    const checked = await callTool(client, "check_items", {
      list: "Pantry #150",
      items: ["Rice", "Beans"],
    });
    for (const item of checked.structuredContent.items as Json[]) {
      isNow(item.checked_at, checkedFrom);
      expect(item.unchecked_at).toBeNull();
    }

    const uncheckedFrom = Date.now();
    await callTool(client, "uncheck_items", {
      list: "Pantry #150",
      items: ["Rice"],
    });
    // A move of a checked item unchecks it too. The output shows it.
    const moved = await callTool(client, "move_items", {
      list: "Pantry #150",
      items: ["Beans"],
      to_list: "Freezer #150",
    });
    const [beans] = moved.structuredContent.items as Json[];
    expect(beans).toMatchObject({ checked: false, checked_at: null });
    isNow(beans.unchecked_at, uncheckedFrom);

    const items = await byName();
    expect(items.Rice).toMatchObject({ checked: false, checked_at: null });
    isNow(items.Rice.unchecked_at, uncheckedFrom);
    const found = await callTool(client, "search_items", { query: "beans" });
    isNow(
      (found.structuredContent.items as Json[])[0].unchecked_at,
      uncheckedFrom,
    );

    // A new check clears the uncheck time.
    await callTool(client, "check_items", {
      list: "Pantry #150",
      items: ["Rice"],
    });
    expect((await byName()).Rice).toMatchObject({ unchecked_at: null });
  });

  it("updates, moves, and deletes items", async () => {
    await callTool(client, "create_list", { name: "Oasis" });
    const updated = await callTool(client, "update_item", {
      list: "Pierre’s General Store",
      item: "bread",
      name: "Sourdough",
      quantity: 2,
    });
    expect(updated.structuredContent).toMatchObject({
      name: "Sourdough",
      quantity: 2,
    });
    const moved = await callTool(client, "move_items", {
      list: "Pierre’s General Store",
      items: ["Sourdough"],
      to_list: "oasis",
    });
    expect(moved.isError).toBeFalsy();
    const target = await callTool(client, "get_list", { list: "Oasis" });
    expect(
      (target.structuredContent.items as Json[]).map((i) => i.name),
    ).toEqual(["Sourdough"]);

    const deleted = await callTool(client, "delete_items", {
      list: "Oasis",
      items: ["Sourdough"],
    });
    expect(deleted.structuredContent.deleted).toEqual([
      expect.objectContaining({ name: "Sourdough" }),
    ]);
  });

  it("marks an item out of stock and in stock (#131)", async () => {
    // Eggs is checked: the mark also unchecks it.
    const marked = await callTool(client, "update_item", {
      list: "Pierre’s General Store",
      item: "eggs",
      out_of_stock: true,
    });
    expect(marked.isError).toBeFalsy();
    expect(marked.structuredContent).toMatchObject({
      name: "Eggs",
      checked: false,
      out_of_stock: true,
    });
    const got = await callTool(client, "get_list", {
      list: "Pierre’s General Store",
    });
    expect(
      (got.structuredContent.items as Json[]).find((i) => i.name === "Eggs"),
    ).toMatchObject({ out_of_stock: true });

    // A check marks it in stock.
    const checked = await callTool(client, "check_items", {
      list: "Pierre’s General Store",
      items: ["Eggs"],
    });
    expect(checked.structuredContent.items).toEqual([
      expect.objectContaining({ checked: true, out_of_stock: false }),
    ]);

    // An unmark with an edit in one call.
    await callTool(client, "update_item", {
      list: "Pierre’s General Store",
      item: "milk",
      out_of_stock: true,
    });
    const both = await callTool(client, "update_item", {
      list: "Pierre’s General Store",
      item: "milk",
      notes: "2%",
      out_of_stock: false,
    });
    expect(both.structuredContent).toMatchObject({
      notes: "2%",
      out_of_stock: false,
    });

    const nothing = await callTool(client, "update_item", {
      list: "Pierre’s General Store",
      item: "milk",
    });
    expect(nothing.isError).toBe(true);
  });

  it("adds, sets, and removes the URL of an item (#140)", async () => {
    const url = "https://example.com/coffee";
    await callTool(client, "create_list", { name: "Cafe" });
    const added = await callTool(client, "add_items", {
      list: "Cafe",
      items: [{ name: "Coffee", url }],
    });
    expect(added.isError).toBeFalsy();
    const got = await callTool(client, "get_list", { list: "Cafe" });
    expect(
      (got.structuredContent.items as Json[]).find((i) => i.name === "Coffee"),
    ).toMatchObject({ url });

    const other = "https://example.com/decaf";
    const set = await callTool(client, "update_item", {
      list: "Cafe",
      item: "coffee",
      url: other,
    });
    expect(set.structuredContent).toMatchObject({ url: other });
    const removed = await callTool(client, "update_item", {
      list: "Cafe",
      item: "coffee",
      url: "",
    });
    expect(removed.structuredContent).toMatchObject({ url: "" });

    // Only http and https: the app opens the link.
    const bad = await callTool(client, "update_item", {
      list: "Cafe",
      item: "coffee",
      url: "javascript:alert(1)",
    });
    expect(bad.isError).toBe(true);
    const after = await callTool(client, "get_list", { list: "Cafe" });
    expect(
      (after.structuredContent.items as Json[]).find(
        (i) => i.name === "Coffee",
      ),
    ).toMatchObject({ url: "" });
  });

  it("unchecks all and clears checked items", async () => {
    await callTool(client, "check_items", {
      list: "Pierre’s General Store",
      items: ["Milk", "Eggs"],
    });
    const unchecked = await callTool(client, "uncheck_all", {
      list: "Pierre’s General Store",
    });
    expect(unchecked.structuredContent.changed_items).toBe(2);
    await callTool(client, "check_items", {
      list: "Pierre’s General Store",
      items: ["Eggs"],
    });
    const cleared = await callTool(client, "clear_checked", {
      list: "Pierre’s General Store",
    });
    expect(cleared.structuredContent.changed_items).toBe(1);
    const got = await callTool(client, "get_list", {
      list: "Pierre’s General Store",
    });
    expect((got.structuredContent.items as Json[]).map((i) => i.name)).toEqual([
      "Milk",
    ]);
  });

  it("renames and deletes a list", async () => {
    const renamed = await callTool(client, "rename_list", {
      list: "Oasis",
      name: "Oasis Run",
    });
    expect(renamed.structuredContent.name).toBe("Oasis Run");
    const deleted = await callTool(client, "delete_list", {
      list: "oasis run",
    });
    expect(deleted.structuredContent).toMatchObject({ name: "Oasis Run" });
    const gone = await callTool(client, "get_list", { list: "Oasis Run" });
    expect(gone.isError).toBe(true);
  });

  it("makes the same change once for a repeated idempotency_key", async () => {
    const args = {
      list: "Pierre’s General Store",
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
      name: "JojaMart",
      idempotency_key: "k",
    });
    const list2 = await callTool(client, "create_list", {
      name: "JojaMart",
      idempotency_key: "k",
    });
    expect(list2.isError).toBeFalsy();
    expect(list2.structuredContent.list_id).toBe(
      list1.structuredContent.list_id,
    );
  });

  it("makes the change when a key comes again with different arguments", async () => {
    const first = await callTool(client, "add_items", {
      list: "Pierre’s General Store",
      items: [{ name: "Kiwis" }],
      idempotency_key: "same-key",
    });
    const second = await callTool(client, "add_items", {
      list: "Pierre’s General Store",
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
      const res = await callTool(client, "get_list", { list: "Casino" });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain("No list matches “Casino”");
      expect(errorText(res)).toContain("“Pierre’s General Store”");
    });

    it("changes nothing when an item is unknown", async () => {
      const res = await callTool(client, "check_items", {
        list: "Pierre’s General Store",
        items: ["Milk", "Caviar"],
      });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain("“Caviar”");
      const got = await callTool(client, "get_list", {
        list: "Pierre’s General Store",
      });
      const milk = (got.structuredContent.items as Json[]).find(
        (i) => i.name === "Milk",
      );
      expect(milk?.checked).toBe(false);
    });

    it("refuses a second list with the same name", async () => {
      const res = await callTool(client, "create_list", {
        name: "pierre’s general store",
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
      [
        "check_items",
        { list: "Pierre’s General Store", items: ["I".repeat(201)] },
      ],
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
        arguments: { list: "Pierre’s General Store", items: [] },
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
      list: "Pierre’s General Store",
      items: [{ name: "Butter" }],
    });
    const got = await callTool(client, "get_list", {
      list: "Pierre’s General Store",
    });
    expect(
      (got.structuredContent.items as Json[]).find((i) => i.name === "Butter"),
    ).toMatchObject({ added: { by: "Sam" } });
  });
});

describe("get_history (#152)", () => {
  let client: Client;
  let sam: Client;
  const LIST = "History #152";
  const OTHER = "Other #152";

  beforeAll(async () => {
    client = await connect("modern");
    const cookie = (await h.signIn(SECOND, "Sam"))!;
    const other = await h.getTokens(await h.registerClient("Sam's Claude"), {
      cookie,
    });
    sam = await connect("modern", other.access_token);

    await callTool(client, "create_list", { name: LIST });
    await callTool(client, "create_list", { name: OTHER });
    await callTool(client, "add_items", {
      list: LIST,
      items: [{ name: "Milk" }, { name: "Eggs" }],
    });
    await callTool(client, "check_items", { list: LIST, items: ["Milk"] });
    await callTool(client, "update_item", {
      list: LIST,
      item: "Eggs",
      quantity: 6,
    });
    await callTool(sam, "add_items", {
      list: LIST,
      items: [{ name: "Bread" }],
    });
    await callTool(client, "delete_items", { list: LIST, items: ["Eggs"] });
    await callTool(client, "move_items", {
      list: LIST,
      items: ["Milk"],
      to_list: OTHER,
    });
    await callTool(client, "delete_list", { list: OTHER });
  });

  async function history(args: Record<string, unknown>) {
    const result = await callTool(client, "get_history", args);
    expect(result.isError, errorText(result)).toBeFalsy();
    return result.structuredContent as unknown as {
      entries: Json[];
      next_cursor: string | null;
    };
  }

  it("gives the changes of a list, the last first, with the moves out of it", async () => {
    const { entries, next_cursor } = await history({ list: LIST });
    expect(entries.map((e) => [e.action, e.item_name, e.by])).toEqual([
      ["moved", "Milk", "Emily"],
      ["deleted", "Eggs", "Emily"],
      ["added", "Bread", "Sam"],
      ["edited", "Eggs", "Emily"],
      ["checked", "Milk", "Emily"],
      ["added", "Eggs", "Emily"],
      ["added", "Milk", "Emily"],
      ["list_created", null, "Emily"],
    ]);
    expect(next_cursor).toBeNull();
    expect(entries[0]).toMatchObject({
      via_claude: true,
      list_name: OTHER,
      from_list_name: LIST,
      also_unchecked: true,
    });
    expect(entries[3]).toMatchObject({
      changes: { quantity: { from: 1, to: 6 } },
    });
    for (const entry of entries) {
      expect(Date.parse(entry.at as string)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("finds a deleted item and a deleted list by name", async () => {
    const eggs = await history({ list: LIST, item: "EGGS" });
    expect(eggs.entries.map((e) => e.action)).toEqual([
      "deleted",
      "edited",
      "added",
    ]);
    const other = await history({ list: OTHER.toLowerCase() });
    expect(other.entries.map((e) => e.action)).toEqual([
      "list_deleted",
      "moved",
      "list_created",
    ]);
  });

  it("filters by person, action, and time", async () => {
    const mine = await history({
      list: LIST,
      person: "me",
      actions: ["checked"],
    });
    expect(mine.entries.map((e) => e.item_name)).toEqual(["Milk"]);
    const sams = await history({ list: LIST, person: "sam" });
    expect(sams.entries.map((e) => e.item_name)).toEqual(["Bread"]);
    const later = await history({
      list: LIST,
      since: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(later.entries).toEqual([]);
    const before = await history({
      list: LIST,
      until: "2000-01-01T00:00:00+01:00",
    });
    expect(before.entries).toEqual([]);
  });

  it("gives pages", async () => {
    const all = (await history({ list: LIST })).entries;
    const first = await history({ list: LIST, limit: 3 });
    expect(first.entries).toEqual(all.slice(0, 3));
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await history({
      list: LIST,
      limit: 5,
      cursor: first.next_cursor,
    });
    expect(second.entries).toEqual(all.slice(3, 8));
    expect(second.next_cursor).toBeNull();
  });

  it("shows an automatic change with no person", async () => {
    const list = await callTool(client, "list_lists", {});
    const listId = (list.structuredContent.lists as Json[]).find(
      (l) => l.name === LIST,
    )!.list_id as string;
    h.db
      .insert(activity)
      .values({
        actorId: null,
        via: "system",
        type: "expireItem",
        listId,
        itemId: crypto.randomUUID(),
        snapshot: { listName: LIST, itemName: "Old jam" },
        at: new Date(),
        opAt: new Date(),
        notifiedAt: new Date(),
      })
      .run();
    const { entries } = await history({ list: LIST, actions: ["expired"] });
    expect(entries).toEqual([
      expect.objectContaining({
        action: "expired",
        by: null,
        via_claude: false,
        item_name: "Old jam",
      }),
    ]);
  });

  it("gives helpful errors", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ item: "Milk" }, /list of the item/],
      [{ list: LIST, item: "Caviar" }, /No item “Caviar”/],
      [{ list: "Nowhere" }, /No list, now or in the history/],
      [{ person: "Krobus" }, /No person matches “Krobus”.*“Emily”/],
      [{ cursor: "nope" }, /cursor is not valid/],
    ];
    for (const [args, message] of cases) {
      const result = await callTool(client, "get_history", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(errorText(result)).toMatch(message);
    }
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
    await callTool(client, "create_list", { name: "Willy’s Fish Shop" });
    await callTool(client, "add_items", {
      list: "Willy’s Fish Shop",
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
      canPush: () => true,
    });
    await notifier.tick();
    const sam = h.db.select().from(users).where(eq(users.email, SECOND)).get()!;
    expect(sent).toEqual([
      {
        userId: sam.id,
        payload: expect.objectContaining({
          title: "Willy’s Fish Shop",
          body: expect.stringMatching(/^Emily \(via Claude\) /),
        }),
      },
    ]);
  });
});

describe("private lists (#154)", () => {
  let emily: Client;
  let haley: Client;

  beforeAll(async () => {
    emily = await connect("modern");
    const cookie = (await h.signIn(SECOND, "Haley"))!;
    const haleyToken = (
      await h.getTokens(await h.registerClient("Haley’s Claude"), { cookie })
    ).access_token;
    haley = await connect("modern", haleyToken);
  });

  it("shows a private list only to its creator", async () => {
    const made = await callTool(emily, "create_list", {
      name: "Gifts #154",
      private: true,
    });
    expect(made.structuredContent).toMatchObject({ private: true });
    const listId = made.structuredContent.list_id as string;
    await callTool(emily, "add_items", {
      list: listId,
      items: [{ name: "Lego Falcon #154" }],
    });

    const emilyLists = await callTool(emily, "list_lists", {});
    expect(emilyLists.structuredContent.lists).toContainEqual(
      expect.objectContaining({ list_id: listId, private: true }),
    );
    const emilyList = await callTool(emily, "get_list", { list: "Gifts #154" });
    expect(emilyList.structuredContent).toMatchObject({ private: true });

    const haleyLists = await callTool(haley, "list_lists", {});
    const haleyIds = (
      haleyLists.structuredContent.lists as { list_id: string }[]
    ).map((l) => l.list_id);
    expect(haleyIds).not.toContain(listId);

    for (const list of [listId, "Gifts #154"]) {
      const got = await callTool(haley, "get_list", { list });
      expect(got.isError).toBe(true);
      // The error names the lists that Haley can see, not the private list.
      const names = errorText(got).split("The lists are:")[1] ?? "";
      expect(names).not.toContain("Gifts #154");
    }
    const found = await callTool(haley, "search_items", {
      query: "falcon #154",
    });
    expect(found.structuredContent.items).toEqual([]);

    const history = await callTool(haley, "get_history", { limit: 200 });
    expect(JSON.stringify(history.structuredContent)).not.toContain(
      "Gifts #154",
    );
    const byList = await callTool(haley, "get_history", { list: listId });
    expect(byList.isError).toBe(true);

    // Haley can make a list with the same name: the check sees only their
    // lists.
    const same = await callTool(haley, "create_list", { name: "Gifts #154" });
    expect(same.isError).toBeFalsy();
    // Emily now sees two lists with that name.
    const both = await callTool(emily, "get_list", { list: "Gifts #154" });
    expect(errorText(both)).toMatch(/More than one list/);
  });

  it("makes a list private and shared again, for its creator only", async () => {
    const made = await callTool(emily, "create_list", { name: "Party #154" });
    const listId = made.structuredContent.list_id as string;

    const refused = await callTool(haley, "set_list_private", {
      list: listId,
      private: true,
    });
    expect(refused.isError).toBe(true);
    expect(errorText(refused)).toMatch(/Only the person who made the list/);

    const priv = await callTool(emily, "set_list_private", {
      list: listId,
      private: true,
    });
    expect(priv.structuredContent).toMatchObject({ private: true });
    expect((await callTool(haley, "get_list", { list: listId })).isError).toBe(
      true,
    );

    const history = await callTool(emily, "get_history", { list: listId });
    expect(
      (history.structuredContent.entries as { action: string }[])[0].action,
    ).toBe("list_made_private");

    await callTool(emily, "set_list_private", { list: listId, private: false });
    const haleyList = await callTool(haley, "get_list", { list: listId });
    expect(haleyList.structuredContent).toMatchObject({ private: false });
    const haleyHistory = await callTool(haley, "get_history", { list: listId });
    expect(
      (haleyHistory.structuredContent.entries as { action: string }[]).map(
        (e) => e.action,
      ),
    ).toEqual(["list_shared", "list_made_private", "list_created"]);
  });

  it("refuses a move between a private and a shared list", async () => {
    await callTool(emily, "create_list", {
      name: "Secret #154",
      private: true,
    });
    await callTool(emily, "create_list", { name: "Open #154" });
    await callTool(emily, "add_items", {
      list: "Open #154",
      items: [{ name: "Wrapping paper" }],
    });
    const moved = await callTool(emily, "move_items", {
      list: "Open #154",
      items: ["Wrapping paper"],
      to_list: "Secret #154",
    });
    expect(moved.isError).toBe(true);
    expect(errorText(moved)).toMatch(/copy_items/);
  });
});

describe("log (#147)", () => {
  it("logs each tool call with IDs only, and the refusals", async () => {
    const { captureLogs } = await import("@/test/logs");
    vi.stubEnv("LOG_LEVEL", "debug");
    const logs = captureLogs();
    try {
      const made = await rpc("tools/call", {
        name: "create_list",
        arguments: { name: "ZQX Log Shop" },
      });
      expect(made.status).toBe(200);
      const missing = await rpc("tools/call", {
        name: "get_list",
        arguments: { list: "ZQX Nowhere" },
      });
      expect(missing.body.result.isError).toBe(true);
      const scoped = await rpc(
        "tools/call",
        { name: "create_list", arguments: { name: "ZQX Other" } },
        { token: readOnlyToken },
      );
      expect(scoped.status).toBe(403);
      const bad = await rpc("tools/list", {}, { token: "not-a-token" });
      expect(bad.status).toBe(401);
      const lines = logs.lines.map((l) => l.replace(/ ms=\d+/, ""));
      const call = (tool: string, result: string) =>
        expect.stringMatching(
          new RegExp(
            `^info \\[mcp\\] call tool=${tool} user=${userId} client=\\S+ result=${result}$`,
          ),
        );
      expect(lines).toEqual(
        expect.arrayContaining([
          call("create_list", "ok"),
          call("get_list", "tool_error"),
          "warn [mcp] refused status=403 reason=insufficient_scope",
          "debug [mcp] refused status=401 reason=token",
        ]),
      );
      // The OAuth lines of an MCP client.
      const clientId = await h.registerClient("Logger");
      await h.getTokens(clientId);
      const bad401 = await h.token({
        grant_type: "refresh_token",
        refresh_token: "nope",
        client_id: clientId,
      });
      expect(bad401.status).toBeGreaterThanOrEqual(400);
      expect(logs.lines).toEqual(
        expect.arrayContaining([
          `info [auth] client registered client=${clientId}`,
          `info [auth] token grant=authorization_code client=${clientId}`,
          expect.stringMatching(
            new RegExp(
              `^warn \\[auth\\] token grant=refresh_token client=${clientId} status=4\\d\\d$`,
            ),
          ),
        ]),
      );
      expect(logs.text()).not.toContain("ZQX");
      expect(logs.text()).not.toContain(token);
      expect(logs.text()).not.toContain("@example.com");
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});

describe("check_all, copy, restore, and move_items (#162)", () => {
  let emily: Client;
  let haley: Client;

  beforeAll(async () => {
    emily = await connect("modern");
    const cookie = (await h.signIn(SECOND, "Haley"))!;
    const haleyToken = (
      await h.getTokens(await h.registerClient("Haley’s Claude #162"), {
        cookie,
      })
    ).access_token;
    haley = await connect("modern", haleyToken);
  });

  async function names(client: Client, list: string) {
    const got = await callTool(client, "get_list", { list });
    expect(got.isError, errorText(got)).toBeFalsy();
    return Object.fromEntries(
      (got.structuredContent.items as Json[]).map((i) => [i.name, i]),
    );
  }

  it("check_all checks off each unchecked item, and gives the count", async () => {
    await callTool(emily, "create_list", { name: "Bulk #162" });
    await callTool(emily, "add_items", {
      list: "Bulk #162",
      items: [{ name: "Rice" }, { name: "Beans" }, { name: "Corn" }],
    });
    await callTool(emily, "check_items", {
      list: "Bulk #162",
      items: ["Corn"],
    });
    const first = await callTool(emily, "check_all", { list: "Bulk #162" });
    expect(first.structuredContent.changed_items).toBe(2);
    const items = await names(emily, "Bulk #162");
    expect(Object.values(items).every((i) => i.checked)).toBe(true);
    const second = await callTool(emily, "check_all", { list: "Bulk #162" });
    expect(second.structuredContent.changed_items).toBe(0);
  });

  it("copy_items adds, unchecks a checked match, and leaves an unchecked match", async () => {
    await callTool(emily, "create_list", { name: "Copy from #162" });
    await callTool(emily, "create_list", { name: "Copy to #162" });
    await callTool(emily, "add_items", {
      list: "Copy from #162",
      items: [
        { name: "Milk", quantity: 2, notes: "Oat" },
        { name: "Eggs", quantity: 12 },
        { name: "Bread" },
      ],
    });
    await callTool(emily, "add_items", {
      list: "Copy to #162",
      items: [{ name: "eggs" }, { name: "Bread", notes: "Rye" }],
    });
    await callTool(emily, "check_items", {
      list: "Copy to #162",
      items: ["eggs"],
    });

    const copied = await callTool(emily, "copy_items", {
      list: "Copy from #162",
      items: ["Milk", "Eggs", "Bread"],
      to_list: "Copy to #162",
    });
    expect(copied.isError, errorText(copied)).toBeFalsy();
    expect(
      (copied.structuredContent.items as Json[]).map((i) => [i.name, i.result]),
    ).toEqual([
      ["Milk", "copied"],
      ["Eggs", "unchecked"],
      ["Bread", "already_on_list"],
    ]);

    const there = await names(emily, "Copy to #162");
    expect(there.Milk).toMatchObject({ quantity: 2, notes: "Oat" });
    expect(there.eggs).toMatchObject({ checked: false, quantity: 12 });
    expect(there.Bread).toMatchObject({ notes: "Rye" });
    // The items stay on the first list.
    expect(Object.keys(await names(emily, "Copy from #162"))).toHaveLength(3);
  });

  it("copy_items: a retry with the same key changes nothing", async () => {
    await callTool(emily, "create_list", { name: "Retry from #162" });
    await callTool(emily, "create_list", { name: "Retry to #162" });
    await callTool(emily, "add_items", {
      list: "Retry from #162",
      items: [{ name: "Tea" }],
    });
    const args = {
      list: "Retry from #162",
      items: ["Tea"],
      to_list: "Retry to #162",
      idempotency_key: "copy-162",
    };
    const first = await callTool(emily, "copy_items", args);
    const again = await callTool(emily, "copy_items", args);
    expect(again.structuredContent.items).toEqual(
      first.structuredContent.items,
    );
    expect(Object.keys(await names(emily, "Retry to #162"))).toEqual(["Tea"]);
  });

  it("copy_items works from a private list to a shared list, and refuses the same list", async () => {
    await callTool(emily, "create_list", {
      name: "Private copy #162",
      private: true,
    });
    await callTool(emily, "create_list", { name: "Shared copy #162" });
    await callTool(emily, "add_items", {
      list: "Private copy #162",
      items: [{ name: "Candles" }],
    });
    const copied = await callTool(emily, "copy_items", {
      list: "Private copy #162",
      items: ["Candles"],
      to_list: "Shared copy #162",
    });
    expect(copied.isError, errorText(copied)).toBeFalsy();
    expect(Object.keys(await names(haley, "Shared copy #162"))).toEqual([
      "Candles",
    ]);

    const same = await callTool(emily, "copy_items", {
      list: "Shared copy #162",
      items: ["Candles"],
      to_list: "Shared copy #162",
    });
    expect(same.isError).toBe(true);
  });

  it("restore_items brings back deleted and expired items", async () => {
    await callTool(emily, "create_list", { name: "Restore #162" });
    await callTool(emily, "add_items", {
      list: "Restore #162",
      items: [{ name: "Apples" }, { name: "Pears" }, { name: "Plums" }],
    });
    await callTool(emily, "check_items", {
      list: "Restore #162",
      items: ["Pears", "Plums"],
    });
    await callTool(emily, "delete_items", {
      list: "Restore #162",
      items: ["Apples"],
    });
    // Plums expires (#112): its check is 31 days old.
    const plums = (await names(emily, "Restore #162")).Plums;
    h.db
      .update(items)
      .set({ checkedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(items.id, plums.item_id as string))
      .run();
    const { expireCheckedItems } = await import("../ops");
    expect(expireCheckedItems({ db: h.db })).toBeGreaterThanOrEqual(1);
    expect(Object.keys(await names(emily, "Restore #162"))).toEqual(["Pears"]);

    const restored = await callTool(emily, "restore_items", {
      list: "Restore #162",
      items: ["apples", plums.item_id, "Pears"],
    });
    expect(restored.isError, errorText(restored)).toBeFalsy();
    expect(
      (restored.structuredContent.items as Json[]).map((i) => [
        i.name,
        i.result,
      ]),
    ).toEqual([
      ["Apples", "restored"],
      ["Plums", "restored"],
      ["Pears", "already_on_list"],
    ]);
    const after = await names(emily, "Restore #162");
    expect(after.Apples).toMatchObject({ checked: false });
    // An expired item comes back unchecked: else it expires again.
    expect(after.Plums).toMatchObject({ checked: false });
    expect(after.Pears).toMatchObject({ checked: true });

    // A retry finds the items on the list, and changes nothing.
    const again = await callTool(emily, "restore_items", {
      list: "Restore #162",
      items: ["apples"],
    });
    expect(again.structuredContent.items).toEqual([
      expect.objectContaining({ name: "Apples", result: "already_on_list" }),
    ]);
  });

  it("restore_items keeps one item for each name, and changes nothing for an unknown item", async () => {
    await callTool(emily, "create_list", { name: "Names #162" });
    await callTool(emily, "add_items", {
      list: "Names #162",
      items: [{ name: "Soap" }, { name: "Salt" }],
    });
    await callTool(emily, "delete_items", {
      list: "Names #162",
      items: ["Soap", "Salt"],
    });
    await callTool(emily, "add_items", {
      list: "Names #162",
      items: [{ name: "Soap" }],
    });

    const unknown = await callTool(emily, "restore_items", {
      list: "Names #162",
      items: ["Salt", "Saffron"],
    });
    expect(unknown.isError).toBe(true);
    expect(errorText(unknown)).toContain("Saffron");
    expect(Object.keys(await names(emily, "Names #162"))).toEqual(["Soap"]);

    const restored = await callTool(emily, "restore_items", {
      list: "Names #162",
      items: ["Soap", "Salt"],
    });
    expect(
      (restored.structuredContent.items as Json[]).map((i) => [
        i.name,
        i.result,
      ]),
    ).toEqual([
      ["Soap", "already_on_list"],
      ["Salt", "restored"],
    ]);
    expect(Object.keys(await names(emily, "Names #162")).sort()).toEqual([
      "Salt",
      "Soap",
    ]);
  });

  it("restore_list brings back a list with its items, and refuses a name that a live list has", async () => {
    await callTool(emily, "create_list", { name: "Gone #162" });
    await callTool(emily, "add_items", {
      list: "Gone #162",
      items: [{ name: "Flour" }, { name: "Sugar" }],
    });
    await callTool(emily, "delete_list", { list: "Gone #162" });

    // A tool on the deleted list tells the model to restore it.
    const add = await callTool(emily, "add_items", {
      list: "Gone #162",
      items: [{ name: "Yeast" }],
    });
    expect(add.isError).toBe(true);
    expect(errorText(add)).toMatch(/restore_list/);

    const restored = await callTool(emily, "restore_list", {
      list: "gone #162",
    });
    expect(restored.structuredContent).toMatchObject({
      name: "Gone #162",
      private: false,
      items: 2,
      result: "restored",
    });
    const again = await callTool(emily, "restore_list", { list: "Gone #162" });
    expect(again.structuredContent).toMatchObject({ result: "not_deleted" });

    // A deleted list whose name is live again.
    await callTool(emily, "delete_list", { list: "Gone #162" });
    await callTool(emily, "create_list", { name: "Gone #162" });
    const clash = await callTool(emily, "restore_list", { list: "Gone #162" });
    expect(clash.isError).toBe(true);
    expect(errorText(clash)).toMatch(/rename_list/);

    const unknown = await callTool(emily, "restore_list", {
      list: "Never #162",
    });
    expect(unknown.isError).toBe(true);
  });

  it("the other person cannot restore a deleted private list", async () => {
    const made = await callTool(emily, "create_list", {
      name: "Hidden #162",
      private: true,
    });
    const listId = made.structuredContent.list_id as string;
    await callTool(emily, "delete_list", { list: listId });
    for (const list of [listId, "Hidden #162"]) {
      const result = await callTool(haley, "restore_list", { list });
      expect(result.isError, list).toBe(true);
      // The same answer as for a list that does not exist.
      expect(errorText(result)).toMatch(/^No (deleted )?list /);
    }
  });

  it("move_items moves many items in one call", async () => {
    await callTool(emily, "create_list", { name: "Move from #162" });
    await callTool(emily, "create_list", { name: "Move to #162" });
    await callTool(emily, "add_items", {
      list: "Move from #162",
      items: [{ name: "Kale" }, { name: "Leeks" }, { name: "Okra" }],
    });
    await callTool(emily, "check_items", {
      list: "Move from #162",
      items: ["Kale"],
    });
    const moved = await callTool(emily, "move_items", {
      list: "Move from #162",
      items: ["Kale", "Leeks"],
      to_list: "Move to #162",
    });
    expect(moved.isError, errorText(moved)).toBeFalsy();
    expect(
      (moved.structuredContent.items as Json[]).map((i) => [i.name, i.checked]),
    ).toEqual([
      ["Kale", false],
      ["Leeks", false],
    ]);
    expect(Object.keys(await names(emily, "Move from #162"))).toEqual(["Okra"]);
    expect(Object.keys(await names(emily, "Move to #162")).sort()).toEqual([
      "Kale",
      "Leeks",
    ]);
  });

  it("sends the other person one grouped push for the changes", async () => {
    h.db.update(activity).set({ notifiedAt: new Date() }).run();
    await callTool(emily, "create_list", { name: "Push #162" });
    await callTool(emily, "add_items", {
      list: "Push #162",
      items: [{ name: "Ham" }, { name: "Jam" }],
    });
    await callTool(emily, "delete_items", {
      list: "Push #162",
      items: ["Ham"],
    });
    await callTool(emily, "restore_items", {
      list: "Push #162",
      items: ["Ham"],
    });
    await callTool(emily, "check_all", { list: "Push #162" });

    const sent: { userId: string; payload: PushPayload }[] = [];
    const notifier = new Notifier({
      db: h.db,
      allowlist: `${ALLOWED},${SECOND}`,
      now: () => Date.now() + QUIET_MS + 1,
      send: async (to, payload) => {
        sent.push({ userId: to, payload });
      },
      canPush: () => true,
    });
    await notifier.tick();
    const haleyRow = h.db
      .select()
      .from(users)
      .where(eq(users.email, SECOND))
      .get()!;
    expect(sent).toEqual([
      {
        userId: haleyRow.id,
        payload: expect.objectContaining({
          title: "Push #162",
          body: expect.stringMatching(/^Emily \(via Claude\) /),
        }),
      },
    ]);
  });
});
