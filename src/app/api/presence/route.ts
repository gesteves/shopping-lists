import { requireApiUser } from "@/lib/session";
import { getPresence } from "@/server/presence";
import { presenceInputSchema } from "@/shared/presence";

// The presence heartbeat (#12). See "Realtime and presence" in docs/PLAN.md.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const parsed = presenceInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  getPresence().set(user.id, parsed.data);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
