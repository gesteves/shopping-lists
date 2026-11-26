import { requireApiUser } from "@/lib/session";
import { getVapidConfig, sendToUser } from "@/server/push";

/** Send a test push to each enabled device of the signed-in user. */
export async function POST() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  if (!getVapidConfig()) {
    return Response.json({ error: "push_not_configured" }, { status: 503 });
  }
  const result = await sendToUser(user.id, {
    title: "Shopping Lists",
    body: "Notifications work on this device.",
    url: "/settings",
    tag: "test",
  });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
