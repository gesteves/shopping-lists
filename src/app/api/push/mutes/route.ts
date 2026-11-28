import { requireApiUser } from "@/lib/session";
import { readJson } from "@/server/json";
import { listMutedListIds, setListMuted } from "@/server/push";
import { readListById } from "@/server/queries";
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
  const body = await readJson(request, muteSchema);
  if (!body.ok) return body.response;
  // A private list of another user is "not found" (#154).
  if (!readListById(body.data.listId, user.id)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  try {
    setListMuted(user.id, body.data.listId, body.data.muted);
  } catch {
    // The list does not exist (foreign key).
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
