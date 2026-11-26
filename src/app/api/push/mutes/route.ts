import { requireApiUser } from "@/lib/session";
import { listMutedListIds, setListMuted } from "@/server/push";
import { muteSchema } from "@/shared/push";

/** The lists that the signed-in user muted. */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return Response.json(
    { listIds: listMutedListIds(user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Mute or unmute one list. */
export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const parsed = muteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    setListMuted(user.id, parsed.data.listId, parsed.data.muted);
  } catch {
    // The list does not exist (foreign key).
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
