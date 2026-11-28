// Next.js calls `register` one time at server start, before the first request.
// It calls it in each runtime. The Node.js code is in its own file, and the
// import is in a NEXT_RUNTIME branch: thus the Edge build does not get it.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
