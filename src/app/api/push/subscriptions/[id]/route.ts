import { requireApiUser } from "@/lib/session";
import { readJson } from "@/server/json";
import { removeSubscription, setSubscriptionEnabled } from "@/server/push";
import { updateSubscriptionSchema } from "@/shared/push";

type Context = RouteContext<"/api/push/subscriptions/[id]">;

/** Turn a device on or off. */
export async function PATCH(request: Request, { params }: Context) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = await readJson(request, updateSubscriptionSchema);
  if (!body.ok) return body.response;
  const { id } = await params;
  const ok = setSubscriptionEnabled(user.id, id, body.data.enabled);
  return ok
    ? new Response(null, { status: 204 })
    : Response.json({ error: "not_found" }, { status: 404 });
}

/** Remove a device. */
export async function DELETE(_: Request, { params }: Context) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  return removeSubscription(user.id, id)
    ? new Response(null, { status: 204 })
    : Response.json({ error: "not_found" }, { status: 404 });
}
