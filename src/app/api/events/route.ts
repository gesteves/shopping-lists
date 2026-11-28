import { requireApiUser } from "@/lib/session";
import { EVENT_HEADERS, createEventStream } from "@/server/events";
import { presenceFor } from "@/server/presence";
import { readHiddenListIds } from "@/server/queries";

// Server-sent events for realtime updates. See "Realtime and presence" in
// docs/PLAN.md.
export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const userId = user.id;
  return new Response(
    createEventStream(request.signal, {
      // The private lists of other users stay out (#154).
      presence: (snapshot) => presenceFor(snapshot, readHiddenListIds(userId)),
    }),
    { headers: EVENT_HEADERS },
  );
}
