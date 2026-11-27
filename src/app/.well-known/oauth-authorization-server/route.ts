import { connection } from "next/server";
import { getAuth } from "@/lib/auth";

// RFC 8414 metadata of the OAuth server (#18). The issuer is the origin, thus
// the path has no suffix. Better Auth makes the document.
export async function GET(request: Request) {
  // Do not prerender: the document has the URLs of the running server.
  await connection();
  return getAuth().handler(request);
}
