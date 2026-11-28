// Read a JSON request body for an API route (#100). It requires
// `application/json`, limits the size, and parses the body with a schema.
// Use a z.strictObject schema: then a body with unknown keys gets 400.
import "server-only";
import type { z } from "zod";
import { log } from "./log";

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

/**
 * The body as UTF-8 text, or null if it is larger than `maxBytes`. A chunked
 * body has no content-length, thus stop at the limit: do not read it all.
 */
async function readText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  // As request.text(): UTF-8, with no BOM.
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<ReadResult<z.output<S>>> {
  const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
  // A refused body: a client bug, or an old client. The path has IDs only;
  // never log the body.
  const refuse = (
    reason: string,
    status: number,
    extra?: { issues: unknown[] },
  ) => {
    log.warn("request", "refused", {
      route: new URL(request.url).pathname,
      status,
      reason,
      issues: extra?.issues.length,
    });
    return fail(reason, status, extra);
  };
  const type = request.headers.get("content-type")?.split(";")[0].trim();
  if (type?.toLowerCase() !== "application/json") {
    return refuse("unsupported_media_type", 415);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) return refuse("too_large", 413);

  const text = await readText(request, maxBytes);
  if (text === null) return refuse("too_large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse("invalid_json", 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return refuse("invalid_request", 400, {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return { ok: true, data: parsed.data };
}
