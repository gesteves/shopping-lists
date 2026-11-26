import { requireApiUser } from "@/lib/session";
import { EVENT_HEADERS, createEventStream } from "@/server/events";

// Server-sent events for realtime updates. See "Realtime and presence" in
// docs/PLAN.md.
export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return new Response(createEventStream(request.signal), {
    headers: EVENT_HEADERS,
  });
}
