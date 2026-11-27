import { requireApiUser } from "@/lib/session";
import { readJson } from "@/server/json";
import { getPresence } from "@/server/presence";
import { presenceInputSchema } from "@/shared/presence";

// The presence heartbeat (#12). See "Realtime and presence" in docs/PLAN.md.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = await readJson(request, presenceInputSchema);
  if (!body.ok) return body.response;
  getPresence().set(user.id, body.data);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
