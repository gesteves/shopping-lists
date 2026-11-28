import { requireApiUser } from "@/lib/session";
import { handlePull } from "@/server/sync";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return handlePull(request, user.id);
}
