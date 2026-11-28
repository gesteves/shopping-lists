import { requireApiUser } from "@/lib/session";
import { handleClientLog } from "@/server/client-log";

// Browser errors for the server log (#147). See "Logging" in docs/PLAN.md.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return handleClientLog(request, user.id);
}
