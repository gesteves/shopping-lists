import { getAuth } from "@/lib/auth";

// Better Auth handles all of /api/auth/*.
const handle = (request: Request) => getAuth().handler(request);

export { handle as GET, handle as POST };
