import { getAuth } from "@/lib/auth";

// RFC 8414 metadata of the OAuth server (#18). The issuer is the origin, thus
// the path has no suffix. Better Auth makes the document.
export const GET = (request: Request) => getAuth().handler(request);
