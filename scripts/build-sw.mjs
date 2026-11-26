// Builds the service worker (src/sw/sw.ts) into public/sw.js, after
// `next build`. It calls the Serwist route handler one time, so the
// precache list comes from the finished build. The list has the files in
// public/ too, thus the self-hosted icons (#51) work offline. The server
// then serves a static file: the Docker image needs no esbuild and no
// source at runtime.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createSerwistRoute } from "@serwist/turbopack";

// The revision changes the precached offline page at each commit. The
// Docker build has no .git, thus it uses a new value at each build.
const revision =
  spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).stdout?.trim() || crypto.randomUUID();

const route = createSerwistRoute({
  swSrc: "src/sw/sw.ts",
  additionalPrecacheEntries: [{ url: "/~offline", revision }],
  useNativeEsbuild: true,
});

for (const params of await route.generateStaticParams()) {
  // Only the worker. A source map would show the source to everyone.
  if (params.path !== "sw.js") continue;
  const res = await route.GET(new Request("http://localhost/"), {
    params: Promise.resolve(params),
  });
  writeFileSync(`public/${params.path}`, await res.text());
  console.log(`Wrote public/${params.path}`);
}
