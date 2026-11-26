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

Copy `.env.example` to `.env.local` and add the values.

The server applies new migrations at start (`src/instrumentation.ts`).

## Deploy

- `fly deploy -a <app> --remote-only --ha=false`. There is one volume, thus one machine. The app name is not in `fly.toml`, because the repository is public. Ask the owner for it, or set `FLY_APP`.
- The image runs `scripts/docker-entrypoint.sh`. It restores the database from R2 on a new volume, then runs the server under `litestream replicate`. If R2 is not available, the machine does not start. This prevents a new empty database.
- Fly secrets (names only): `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`. Never set `AUTH_STUB` on Fly. Set secrets with `fly secrets set`. Secrets made in the Fly dashboard did not get to new machines (#3).
- Cloudflare: a proxied DNS record to Fly, and rules for this host only: Full (strict) SSL, and no cache for `/api/*` and `/sw.js`. Do not change the zone settings: other hosts use the zone.

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
- The repository and the issues are public. Do not put emails, domains, IDs, or secrets in them. Put secrets in Fly secrets or `.env.local`.
- Use the `cf` CLI for Cloudflare. Run each change with `--dry-run` first.
- The MCP server follows spec 2026-07-28. Read the spec again before MCP work.
- For Claude API code, load the `claude-api` skill first.
- For UI work, use the `frontend-design` skill.
