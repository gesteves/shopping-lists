import { requireApiUser } from "@/lib/session";
import {
  EVENT_HEADERS,
  createEventStream,
  openStreamCount,
} from "@/server/events";
import { log } from "@/server/log";
import { presenceFor } from "@/server/presence";
import { readHiddenListIds } from "@/server/queries";

// Server-sent events for realtime updates. See "Realtime and presence" in
// docs/PLAN.md.
export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const userId = user.id;
  const started = performance.now();
  log.debug("events", "open", { user: userId });
  return new Response(
    createEventStream(request.signal, {
      // The private lists of other users stay out (#154).
      presence: (snapshot) => presenceFor(snapshot, readHiddenListIds(userId)),
      // One line for each connection, at its end.
      onClose: (reason) =>
        log.info("events", "closed", {
          user: userId,
          reason,
          ms: Math.round(performance.now() - started),
          open: openStreamCount(),
        }),
    }),
    { headers: EVENT_HEADERS },
  );
}
