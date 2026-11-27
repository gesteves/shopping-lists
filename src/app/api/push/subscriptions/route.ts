import { authStubEnabled } from "@/lib/auth-stub";
import { requireApiUser } from "@/lib/session";
import { readJson } from "@/server/json";
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
  // The e2e tests use a loopback endpoint that refuses each push.
  const schema = subscribeSchema({ allowLoopback: authStubEnabled() });
  const body = await readJson(request, schema);
  if (!body.ok) return body.response;
  const subscription = saveSubscription(user.id, body.data);
  if (!subscription) {
    return Response.json(
      { error: "endpoint_in_use" },
      { status: 409, headers: NO_STORE },
    );
  }
  return Response.json({ subscription }, { status: 201, headers: NO_STORE });
}
