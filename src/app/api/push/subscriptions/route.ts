import { requireApiUser } from "@/lib/session";
import { listSubscriptions, saveSubscription } from "@/server/push";
import { subscribeSchema } from "@/shared/push";

const NO_STORE = { "Cache-Control": "no-store" };

/** The devices of the signed-in user that can get pushes. */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return Response.json(
    { subscriptions: listSubscriptions(user.id) },
    { headers: NO_STORE },
  );
}

/** Save the push subscription of this browser. */
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const parsed = subscribeSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  return Response.json(
    { subscription: saveSubscription(user.id, parsed.data) },
    { status: 201, headers: NO_STORE },
  );
}
