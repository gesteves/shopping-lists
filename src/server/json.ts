// Read a JSON request body for an API route (#100). It requires
// `application/json`, limits the size, and parses the body with a schema.
// Use a z.strictObject schema: then a body with unknown keys gets 400.
import "server-only";
import type { z } from "zod";

const NO_STORE = { "Cache-Control": "no-store" };

/** The default limit, in bytes. */
export const MAX_JSON_BYTES = 16_384;

export type ReadResult<T> =
  { ok: true; data: T } | { ok: false; response: Response };

function fail(error: string, status: number, extra: object = {}) {
  return {
    ok: false as const,
    response: Response.json({ error, ...extra }, { status, headers: NO_STORE }),
  };
}

export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<ReadResult<z.output<S>>> {
  const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
  const type = request.headers.get("content-type")?.split(";")[0].trim();
  if (type?.toLowerCase() !== "application/json") {
    return fail("unsupported_media_type", 415);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) return fail("too_large", 413);

  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) return fail("too_large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("invalid_json", 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", 400, {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return { ok: true, data: parsed.data };
}
