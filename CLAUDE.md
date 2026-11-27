# Shopping Lists

A private shopping list app for two users. It is a mobile-first PWA with offline sync, realtime updates, push notifications, and an MCP server.

Read `docs/PLAN.md` before you start a task. It has the architecture and the decisions.

## Writing rule

Write all code comments, all the inline documentation, and any change to an agent document in ASD-STE100 Simplified Technical English, and keep it short.

## Stack

- Next.js (App Router), TypeScript, Tailwind. Node runtime. Standalone output.
- SQLite with Drizzle ORM. Litestream replicates the database to Cloudflare R2.
- Dexie (IndexedDB) on the client. Serwist service worker.
- Better Auth with Google. Only emails in `ALLOWED_EMAILS` can sign in.
- Fly.io (one machine, always on) behind Cloudflare.

## Commands

Use npm. Node 24 or later.

- `npm run dev`: start the dev server.
- `npm run build`: make the standalone build in `.next/standalone`.
- `npm start`: run the standalone build. It reads `.env.local` if it exists. Set the port with `PORT`.
- `npm run lint`: run ESLint.
- `npm run format`: run Prettier. `npm run format:check` only checks.
- `npm run typecheck`: make the route types, then run `tsc`.
- `npm test`: run the unit tests (Vitest, `src/**/*.test.ts`).
- `npm run test:e2e`: build, start, and run the Playwright tests (`e2e/`). Run `npx playwright install chromium webkit` one time first.
- `npm run db:generate`: make a migration in `drizzle/` from `src/db/schema.ts`.
- `npm run db:migrate`: apply the migrations to `DATABASE_PATH` (default `./data/dev.db`).
- `npm run try:summaries`: print the Claude notification summary for three sample bursts. It needs `ANTHROPIC_API_KEY` and makes three small API calls.

Copy `.env.example` to `.env.local` and add the values.

The server applies new migrations at start (`src/instrumentation.ts`).

## Deploy

- CI (`.github/workflows/ci.yml`) runs the checks on each pull request and on `main`. The checks must pass before a merge.
- A merge to `main` deploys to Fly after the checks pass, then calls the health check. `[skip deploy]` or `[no deploy]` in the head commit message stops the deploy. A manual run (`workflow_dispatch`) from `main` deploys again.
- Obey the security rules in the comments of `ci.yml` and `.github/actions/`. The checks need the two registry tokens, thus PRs from forks fail. Send each Slack message through `.github/actions/notify-slack`, and obey its rules.
- `fly deploy -a <app> --remote-only --ha=false`. There is one volume, thus one machine. The app name is not in `fly.toml`, because the repository is public. Ask the owner for it, or set `FLY_APP`.
- Backups, the restore drill, and the restore of the live app: `docs/ops.md`. Never run the normal entrypoint on a second machine: two Litestream replicas damage the backup.
- The image runs `scripts/docker-entrypoint.sh`. It restores the database from R2 on a new volume, then runs the server under `litestream replicate`. If R2 is not available, the machine does not start. This prevents a new empty database.
- Fly secrets (names only): `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (make them with `npx web-push generate-vapid-keys`; `VAPID_SUBJECT` is optional, the default is the app URL), `ANTHROPIC_API_KEY`. Never set `AUTH_STUB` on Fly. Set secrets with `fly secrets set`. Secrets made in the Fly dashboard did not get to new machines (#3).
- Cloudflare: a proxied DNS record to Fly, and rules for this host only: Full (strict) SSL, and no cache for `/api/*` and `/sw.js`. Do not change the zone settings: other hosts use the zone.

## Dependencies

- The Pro packages (`@web.awesome.me/webawesome-pro`, `@fortawesome/pro-regular-svg-icons`) come from private registries (`.npmrc`). `npm install` needs `WEBAWESOME_NPM_TOKEN` and `FONTAWESOME_NPM_AUTH_TOKEN` in the env. Never put a token value in a file. CI gives them only to the install and deploy steps; the Docker build gets them as build secrets.

- Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm, GitHub Actions, and the Docker base images. CI must pass before a merge. Do not merge a Dependabot PR that has a failed check.
- `allowScripts` in `package.json` controls which install scripts npm runs. CI fails if a package with an install script has no entry (`npm install-scripts ls`).
  - `better-sqlite3` is pinned to an exact version, because it must build its native module. When Dependabot bumps it, CI fails. To fix it: read the changes in the new version, then check out the Dependabot branch, run `npm install-scripts approve better-sqlite3` and `npm install-scripts prune`, and push.
  - `esbuild` and `fsevents` are denied. They work without their scripts: esbuild loads its binary from an `@esbuild/<platform>` package, and fsevents has a prebuilt binary.
  - For a new package with an install script, find out if it needs the script. If not, deny it. If it does, approve it pinned to the version.
- A Node major update changes the two `node` tags in the `Dockerfile`. Also change `.nvmrc` and the major of `@types/node`. Use only LTS (even) majors. Dependabot ignores the `@types/node` majors.

## Next.js

This project uses Next.js 16, with Cache Components on. Your training data can be old. Before you write Next.js code, read the related guide in `node_modules/next/dist/docs/`.

## Workflow

1. Do one ticket in each session. The tickets are the GitHub Issues in milestone `v1`.
2. Find the next ticket: `gh issue list --milestone v1 --state open`. Select the lowest number whose dependencies are closed. A ticket with the `priority` label goes first, if its dependencies are closed.
3. Read the issue, `docs/PLAN.md`, and the comments on the issues it depends on.
4. Make a branch `NN-slug` (for example, `05-apply-ops`).
5. Make all acceptance criteria pass. Add tests for each criterion that you can test.
6. Open a pull request with `Closes #N` in the body.
7. If your work is different from the plan, write a comment on the issue. If a decision changes, update `docs/PLAN.md` in the same pull request.

## Rules

- All writes go through `applyOps` in `src/server/ops.ts`. This applies to the app, sync, and MCP.
- `src/proxy.ts` only looks for the session cookie. Each page must call `requireUser()`, and each API route must call `requireApiUser()` (`src/lib/session.ts`). Call them in a `<Suspense>` boundary.
- `/mcp` does not use the session: `withMcpAuth` (`src/server/mcp/auth.ts`) checks the token. Accept no other tokens. To add a tool, add it to `TOOLS` in `src/server/mcp/tools.ts` with its scope, annotations, and input and output schemas, and add it to the contract tests.
- The OAuth server for MCP clients is Better Auth (`mcp()`, `cimd()`, `jwt()` in `src/lib/auth.ts`). Its tables are in `src/db/schema.ts`. If a Better Auth update changes the plugin schema, compare it with the output of `npx auth generate`.
- The repository and the issues are public. Do not put emails, domains, IDs, or secrets in them. Put secrets in Fly secrets or `.env.local`.
- Use the `cf` CLI for Cloudflare. Run each change with `--dry-run` first.
- The MCP server follows spec 2026-07-28. Read the spec again before MCP work.
- For Claude API code, load the `claude-api` skill first.
- For UI work, use the `frontend-design` skill.
- Every UI change must work in light and dark. Dark mode follows the system setting with no JavaScript: never set `.wa-dark`, `.wa-invert`, or the color scheme with JavaScript.
- The UI uses Web Awesome Pro components (`<wa-*>`, #51). Import each new component in `src/app/web-awesome.ts`. `npm run assets` writes the base layer (`src/app/generated/base.css`): a Tailwind preflight that skips `wa-*` tags, and each tag hidden until defined. Do not import `tailwindcss` whole: its preflight removes the padding and borders of components. Style a component only through its attributes, its `--wa-*` tokens, and its documented parts; read its reference in `node_modules/@web.awesome.me/webawesome-pro/dist/skills/` first. Add `wa-*` event listeners with `useWaEvents` (`src/app/(app)/_components/wa.tsx`), not with `onwa-*` props: hydration does not attach them. Use kebab-case boolean attributes and closing tags.
- Colors: change the `--wa-*` tokens in the `wa-theme-overrides` layer of `src/app/globals.css`. Tailwind color utilities (`bg-canvas`, `text-ink`, …) point to them. Use no other colors.
- Icons: Font Awesome Pro, classic regular (`<wa-icon name="…">`), and `family="brands"` for brands. Add each icon name to `src/app/icons.json`. `npm run assets` writes the SVGs to `public/icons/` (gitignored: never commit Pro SVGs). Give an icon-only control a `label` on its `<wa-icon>`.
