import { requireApiUser } from "@/lib/session";
import { removeSubscription, setSubscriptionEnabled } from "@/server/push";
import { updateSubscriptionSchema } from "@/shared/push";

type Context = RouteContext<"/api/push/subscriptions/[id]">;

/** Turn a device on or off. */
export async function PATCH(request: Request, { params }: Context) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const parsed = updateSubscriptionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const { id } = await params;
  const ok = setSubscriptionEnabled(user.id, id, parsed.data.enabled);
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
