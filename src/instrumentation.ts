import type { Instrumentation } from "next";

// Next.js calls `register` one time at server start, before the first request.
// It calls it in each runtime. The Node.js code is in its own file, and the
// import is in a NEXT_RUNTIME branch: thus the Edge build does not get it.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}

// Next.js calls this for an error that a route, a page, or an action did
// not catch (#147). Log the route template only: the path can have a query,
// and the headers have the cookies.
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("@/server/log");
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String(error.digest)
      : undefined;
  log.error(
    "request",
    "failed",
    {
      method: request.method,
      route: context.routePath,
      type: context.routeType,
      digest,
    },
    error,
  );
};
