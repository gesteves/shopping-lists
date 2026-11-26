import { requireApiUser } from "@/lib/session";
import { handlePush } from "@/server/sync";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return handlePush(request, user);
}
