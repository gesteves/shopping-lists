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

Ticket #1 adds the commands. Put them here when you do #1.

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
- The repository and the issues are public. Do not put emails, domains, IDs, or secrets in them. Put secrets in Fly secrets or `.env.local`.
- Use the `cf` CLI for Cloudflare. Run each change with `--dry-run` first.
- The MCP server follows spec 2026-07-28. Read the spec again before MCP work.
- For Claude API code, load the `claude-api` skill first.
- For UI work, use the `frontend-design` skill.
