import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// An optimistic check: it looks only for the session cookie. Pages and API
// routes must also call the functions in `src/lib/session.ts`.

/** Paths that do not need a session. */
const PUBLIC_PATHS = ["/sign-in", "/api/auth", "/api/health"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname) || getSessionCookie(request)) {
    return NextResponse.next();
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/sign-in", request.url));
}

export const config = {
  // Do not run on build assets and static files.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|svg|ico|webmanifest|txt)$).*)",
  ],
};
