import { copy } from "@/copy";
import { requireApiUser } from "@/lib/session";
import { readJson } from "@/server/json";
import { getVapidConfig, sendToUser } from "@/server/push";
import { testPushSchema } from "@/shared/push";

/**
 * Send a test push to each enabled device of the signed-in user. The body is
 * `{}`: a JSON body cannot come from a plain HTML form of another site.
 */
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = await readJson(request, testPushSchema);
  if (!body.ok) return body.response;
  if (!getVapidConfig()) {
    return Response.json({ error: "push_not_configured" }, { status: 503 });
  }
  const result = await sendToUser(user.id, {
    title: copy.push.title,
    body: copy.push.testBody,
    url: "/settings",
    tag: "test",
  });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
