import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readJson } from "./json";

const schema = z.strictObject({ name: z.string() });
const URL = "http://localhost/api/test";

/** A body with no content-length: the chunks of a stream. */
function chunked(chunks: string[], pulled: { count: number }) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled.count++;
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

describe("readJson", () => {
  it("reads a chunked body under the limit", async () => {
    const pulled = { count: 0 };
    const res = await readJson(chunked(['{"name":', '"Ana"}'], pulled), schema);
    expect(res).toEqual({ ok: true, data: { name: "Ana" } });
  });

  it("gives 413 to a chunked body over the limit, and stops reading", async () => {
    const pulled = { count: 0 };
    const chunks = Array.from({ length: 100 }, () => "x".repeat(1000));
    const res = await readJson(chunked(chunks, pulled), schema, {
      maxBytes: 4000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(413);
      expect(await res.response.json()).toEqual({ error: "too_large" });
    }
    expect(pulled.count).toBeLessThan(10);
  });

  it("gives 413 when the content-length is over the limit", async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(100) }),
    });
    const res = await readJson(req, schema, { maxBytes: 50 });
    expect(res.ok || res.response.status).toBe(413);
  });

  it("gives 415 to another type, and 400 to bad JSON or unknown keys", async () => {
    const post = (type: string, body: string) =>
      readJson(
        new Request(URL, {
          method: "POST",
          headers: { "content-type": type },
          body,
        }),
        schema,
      );
    const status = async (p: ReturnType<typeof post>) => {
      const res = await p;
      return res.ok ? 200 : res.response.status;
    };
    expect(await status(post("text/plain", '{"name":"Ana"}'))).toBe(415);
    expect(await status(post("application/json", "{"))).toBe(400);
    expect(await status(post("application/json", '{"name":"A","x":1}'))).toBe(
      400,
    );
    expect(
      await status(post("application/json; charset=utf-8", '{"name":"A"}')),
    ).toBe(200);
  });
});
