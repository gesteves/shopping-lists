# Shopping Lists: Plan

This doc holds the architecture and the decisions behind it. The work itself is tracked as [GitHub Issues #1–#20, #22, #24 and #25](https://github.com/gesteves/shopping-lists/milestone/1) (milestone `v1`). When a decision changes during a ticket, update this file in the same PR.

## Context
A private shopping-list app for two people. It's mobile-first: an iPhone home-screen PWA used in the store, with a responsive layout for planning on a laptop. Sign-in is with Google, limited to an allowlist.

The hard requirements:
- offline editing with later sync;
- realtime updates and presence;
- push notifications;
- MCP access for Claude.

It's hosted on Fly.io behind Cloudflare.

### Decisions
- **Stack:** Next.js + TypeScript, run as a long-lived Node server on Fly. Data lives on the client in IndexedDB, with a custom sync layer.
- **Notifications:** pushes are grouped per burst (~60s window). A single change uses the exact template. Several changes get a one-line summary written by Claude Opus 5.5 at low effort, with a fixed template as the fallback.
- **Agent edits:** recorded as the user, with a "via Claude" tag (e.g. "Sam (via Claude) added …"). Only the other person is notified.
- **v1 extras:** bulk reset (clear checked / uncheck all), autocomplete and dedupe, undo for deletes, rename list, move item between lists.
- **Presence:** an avatar dot on lists the other person has open, and an "editing…" badge on the item they are editing.
- **MCP:** a remote MCP server that follows spec 2026-07-28, using OAuth 2.1 (Client ID Metadata Documents first, with DCR as a fallback) behind the same Google allowlist. No personal access tokens.
- **Notification preferences:** push on/off per device, and mute per list.
- **Claude Duet:** it uses the connected apps on the Claude account. It's a proactive agent that runs in the cloud and asks for approval before deleting anything. The same remote MCP connector works for Claude.ai (web, Desktop, mobile), Claude Code and Duet. Duet's needs are covered in [MCP](#mcp): long-lived tokens, tool annotations, and safe retries.

### Notification templates
- “[Name] created [a|an] “[list]” list”
- “[Name] deleted the “[list]” list”
- “[Name] renamed the “[old]” list to “[new]””
- “[Name] added “[item]” to the “[list]” list”
- “[Name] updated “[item]” in the “[list]” list”
- “[Name] removed “[item]” from the “[list]” list”
- “[Name] checked “[item]” off the “[list]” list”
- “[Name] unchecked “[item]” in the “[list]” list”
- “[Name] moved “[item]” from the “[A]” list to the “[B]” list”
- “[Name] cleared checked items from the “[list]” list”
- “[Name] unchecked everything in the “[list]” list”

When the change came over MCP, "[Name]" becomes "[Name] (via Claude)".

## Architecture

```
iPhone/laptop PWA ──HTTPS──> Cloudflare (proxy) ──> Fly.io: 1 always-on machine
  React UI                                           Next.js (standalone, Node runtime)
  Dexie (IndexedDB): lists, items, outbox, meta      ├─ /api/sync/push, /api/sync/pull
  Serwist service worker (shell cache, push)         ├─ /api/events (SSE: pokes + presence)
                                                     ├─ /api/presence (heartbeat POST)
Claude (MCP client) ──OAuth──> /mcp ─────────────────├─ /mcp (stateless Streamable HTTP, spec 2026-07-28)
                                                     ├─ Better Auth (Google sessions) + OAuth AS for MCP
                                                     ├─ notifier worker (in-process interval)
                                                     └─ SQLite on Fly volume ──Litestream──> R2
```

**Why one always-on machine with SQLite:** there are two users, so SQLite is enough. Keeping everything in one process lets realtime pub/sub and presence be a simple in-memory event emitter. The notifier's timers also need the machine running (`auto_stop_machines = "off"`, `min_machines_running = 1`). Litestream replicates the database continuously to Cloudflare R2.

**Libraries:**
- next (App Router, `output: "standalone"`), react, tailwindcss
- drizzle-orm + better-sqlite3
- better-auth (Google provider)
- dexie + dexie-react-hooks
- @serwist/next
- web-push
- @anthropic-ai/sdk
- zod
- @modelcontextprotocol/sdk, only if it supports 2026-07-28; otherwise a small custom handler
- jose, and possibly oidc-provider
- vitest, playwright

## Data model
Schema in `src/db/schema.ts`.

| Table | Columns / purpose |
|---|---|
| `users` | id, email, name (Google given name), avatar_url |
| `lists` | id (UUID generated on the client), name, created_by/at, updated_by/at, updated_via (`app` \| `mcp`), deleted_at, clocks (JSON), seq |
| `items` | id (UUID), list_id, name, name_key (normalized for dedupe), quantity (int, default 1), notes, checked, checked_at, created_by/at, updated_by/at, updated_via, deleted_at, clocks (JSON, one HLC timestamp per field), seq |
| `processed_ops` | op_id, which makes pushes idempotent |
| `activity` | id, actor_id, via, type, list_id, item_id, snapshot (names at that moment), at, notified_at. Drives notifications. |
| `push_subscriptions` | id, user_id, endpoint, keys, device_label, enabled, last_success_at |
| `list_mutes` | user_id, list_id |
| `server_seq` | one global counter. Every write gets the next seq. |

Better Auth uses `users`, `sessions`, `accounts`, and `verifications`. The OAuth server has its own tables.

**Allowlist:** the `ALLOWED_EMAILS` environment variable. Better Auth's `user.validateUserInfo` rejects any other email before a user row is created. It checks again at each Google sign-in. `getCurrentUser` also treats a session for an email that is no longer in the list as signed out.

**Sessions:** long and rolling (~180 days), because re-authenticating inside an iOS PWA is awkward. Server Components cannot set cookies, so they read the session with `disableRefresh`. `<SessionRefresh>` calls `/api/auth/get-session` when the app opens or comes to the front, and that call extends the session and the cookie.

## Sync design
**One mutation pipeline for everyone.** UI, sync and MCP all call `applyOps(actor, via, ops[])` in `src/server/ops.ts`. It runs in one SQLite transaction and:
1. skips op_ids already in `processed_ops`;
2. merges each op field by field, last-writer-wins by HLC timestamp. A field is written only if the op's timestamp is newer than that field's clock;
3. bumps seq and sets updated_by/at/via;
4. writes `activity` rows;
5. emits `poke` on the in-process bus.

Because of this, realtime updates, notifications and attribution behave the same whether a change comes from the app or from Claude.

**Op types:** createList, renameList, deleteList, restoreList, addItem, updateItem(fields), check, uncheck, deleteItem, restoreItem, moveItem, clearChecked, uncheckAll.

**Client** (`src/client/sync/`):
- A change is written to Dexie optimistically and added to the outbox. The UI reads Dexie through `useLiveQuery`, so it works the same online and offline.
- Each sync cycle: push the outbox → pull rows with `seq > cursor` (tombstones included) → re-apply any ops still pending.
- Sync runs on startup, on `online`, on `visibilitychange` to visible, on an SSE `poke`, and after each local write (debounced).

**Conflict rules:**
- Concurrent edits to different fields both survive (e.g. one person checks an item while the other edits its notes).
- For the same field, the later edit wins.
- Delete vs. edit: the later timestamp wins. Restore (undo) clears the tombstone.
- Adding an item to a list that was deleted while you were offline is rejected. The client shows a toast offering to re-create the list.
- Tombstones are purged after 30 days.

**Offline auth:** if the session has expired, the outbox keeps queuing. On a 401, show "Sign in again to sync N changes" without dropping anything.

**Storage:** call `navigator.storage.persist()`. iOS has no Background Sync API, so syncing happens whenever the app is opened or comes back to the foreground.

**Dedupe:**
- `name_key` is the name lowercased and trimmed, with spaces collapsed.
- Adding a name that matches an item already on the list opens an "Already on the list. Uncheck it?" prompt. If the match is already unchecked, it offers to increase the quantity.
- The server never creates a second row with the same `name_key` on a list. It returns `merged`, and the client drops its local row.
- MCP `add_items` does the same automatically and reports what happened.

**Autocomplete:** suggests names from every item ever added, ranked by how often and how recently.

**Sorting:** unchecked first, then `updated_at` descending.

## Realtime and presence
- **`GET /api/events`:** an SSE stream.
  - A comment heartbeat every 20s keeps it under Cloudflare's 100s idle timeout.
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
  - Events: `poke {seq}` and `presence {userId, listId, editingItemId}`.
- **`POST /api/presence`:** a heartbeat every 15s, and whenever your current view or editing target changes. The server keeps a 30s-TTL map in memory and broadcasts changes. Presence is hidden while offline.

## Notifications
Code in `src/server/notify/`.

**Worker:** an in-process interval (~10s) scans for `activity` rows with no `notified_at`. It sends a group of (actor, recipient) once the actor has been quiet for 60s, or 3 minutes after the first event at most. Pending state lives in the database, so a restart loses nothing.

**Recipients:** every user except the actor. Muted lists are left out per recipient, and so are disabled devices.

**`collapse.ts`:** cancels out changes that add up to nothing.
- Check then uncheck → nothing.
- Add then delete, including an undone delete → nothing.
- Add then update → "added".
- Several updates → one update.

**One event left:** `templates.ts` fills the exact template, with curly quotes, a/an, and "(via Claude)".

**More than one event left:** `summarize.ts` calls Claude.
- `@anthropic-ai/sdk`, model `claude-opus-5-5`, with `output_config: { effort: "low", format: <zod { body: string }> }`.
- Server-side refusal fallbacks: beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`.
- 10s timeout and 1 retry. Check `stop_reason`.
- The prompt asks for one line of at most ~120 characters, in the same voice as the templates, with counts and list names. For example: "Sam added 12 items to the “Whole Foods” list and checked 3 off “Target”".
- On any error or refusal, it falls back to "[Name] made N changes to …".

**Sending:** `web-push` with VAPID keys. The payload carries a deep-link URL, and the notification `tag` is the list ID. Subscriptions that return 404 or 410 are deleted.

**Settings:** "Enable notifications" must be tapped by the user, as iOS requires, and it only works in the installed PWA. Each device has its own on/off toggle, and each list has a mute toggle.

## MCP
Targets spec **2026-07-28**. Code in `src/app/mcp/route.ts` and `src/server/mcp/*`. References: [spec](https://modelcontextprotocol.io/specification/2026-07-28), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [deprecated](https://modelcontextprotocol.io/specification/2026-07-28/deprecated). Re-read them at the start of #18 and #19.

### Protocol versions
- `2026-07-28` is the main version. Its path is stateless, with no handshake.
- Keep `2025-11-25` until we've confirmed which version claude.ai and Duet send. A request that sends `initialize` goes down the legacy path.
- Both paths share the same tool registry.

### Transport
Streamable HTTP at `/mcp`, stateless.
- `POST` only. `GET` and `DELETE` return 405.
- No `Mcp-Session-Id`, no per-connection state, no SSE resumability.
- Each request's version comes from `_meta["io.modelcontextprotocol/protocolVersion"]`.
- `server/discover` returns `supportedVersions`, `capabilities: { tools: {} }`, `instructions`, `ttlMs`, `cacheScope`, and `serverInfo` in `_meta`.
- Every result includes `resultType: "complete"`.
- Header checks. Each failure returns 400:

  | Header | Rule | Error on mismatch |
  |---|---|---|
  | `MCP-Protocol-Version` | must equal the `_meta` version | `HeaderMismatch` (-32020) |
  | `Mcp-Method` | required on every request | |
  | `Mcp-Name` | required on `tools/call` | |

- An unknown version gets 400 with `UnsupportedProtocolVersion` (-32022), including `data.supported`.
- Validate `Origin`: 403 if it's present and not allowed.
- Return JSON responses. Only stream SSE if something needs it, and then send `X-Accel-Buffering: no` and keep-alives. Closing the stream counts as cancellation.
- Not used: sampling, roots and logging (all deprecated); `subscriptions/listen` and the tasks extension (not needed); elicitation (Duet's own approval step covers destructive actions).

### Implementation
Use the official `@modelcontextprotocol/sdk` if, at ticket time, it supports 2026-07-28 statelessly alongside a 2025-11-25 fallback. Otherwise write a small JSON-RPC handler covering `server/discover`, `tools/list`, `tools/call` and legacy `initialize`, validated with zod and contract tests.

### Authorization
OAuth 2.1. The app is both the authorization server (AS) and the resource server.

**Discovery:**
- Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, with `authorization_servers`.
- A 401 sends `WWW-Authenticate: Bearer resource_metadata="…"`. A missing scope gets 403 `insufficient_scope` naming every scope the request needs.
- AS metadata (RFC 8414) at `/.well-known/oauth-authorization-server`. The `issuer` must match exactly. It advertises:
  - `client_id_metadata_document_supported: true`;
  - `registration_endpoint` (DCR is deprecated, but older clients still use it);
  - `authorization_response_iss_parameter_supported: true`;
  - PKCE S256;
  - `scopes_supported: ["lists:read", "lists:write", "offline_access"]`.

**Client registration:**
- Client ID Metadata Documents first: fetch the https `client_id` URL, check that `client_id` matches exactly, use its `redirect_uris`, and cache it. Guard against SSRF: https only, timeouts, size limits, no private IPs.
- DCR as a fallback, requiring `application_type`.

**Tokens:**
- `iss` (RFC 9207) goes in every authorization response, errors included.
- The `resource` parameter (RFC 8707) is required. Each token's `aud` is bound to the canonical `https://<host>/mcp` and checked on every call.
- Google tokens never reach the MCP endpoint.
- Access tokens are short-lived (opaque, or JWTs signed with `jose`).
- Refresh tokens last ~90 days, rotate on use, and are issued when `offline_access` is granted, so Duet keeps working in the background.

**Consent:** Google sign-in (allowlist), then a consent screen that names the client. The token belongs to that user, and its ops are recorded with `via: "mcp"`.

**Library:** #18 starts by checking Better Auth's OAuth provider against the lists above: RFC 8707 audience binding, CIMD, RFC 9207 `iss`, PRM. If it falls short, use `oidc-provider` (resource indicators and `iss`, with CIMD added through its client lookup), or a minimal AS of our own on `jose`. Better Auth stays for the app's own Google sessions either way.

**Connected apps:** a settings section lists the authorized clients and lets you revoke each one.

### Tools
- `tools/list` returns tools in a fixed order, with `ttlMs` and `cacheScope: "private"`.
- Every tool has `title`, `description`, `inputSchema` and `outputSchema`. Results return matching `structuredContent`, plus the same JSON in a text block.
- Business errors (unknown list, deleted item) return `isError: true`. Malformed calls get -32602.
- Each tool accepts a `list_id` (returned by `create_list`) or a case-insensitive list name.
- Write tools accept an optional `idempotency_key`, which becomes the op_id.
- Every write calls `applyOps`. Reads use `src/server/queries.ts`.
- Every tool sets `openWorldHint: false`.

| Tool | Annotations | Notes |
|---|---|---|
| `list_lists` | readOnly | |
| `get_list` | readOnly | items, with who added and updated each one, and when |
| `search_items` | readOnly | across all lists |
| `create_list` | | returns `list_id` |
| `rename_list` | idempotent, non-destructive | |
| `delete_list` | **destructive** | |
| `add_items` | non-destructive | batch; dedupes |
| `update_item` | idempotent | |
| `check_items`, `uncheck_items` | idempotent, non-destructive | |
| `delete_items` | **destructive**, idempotent | |
| `move_item` | idempotent | |
| `clear_checked` | **destructive** | |
| `uncheck_all` | idempotent | |

**Server instructions** (in `server/discover`) explain the data model, sorting, dedupe (adding an existing item unchecks it), "via Claude" attribution, and that destructive tools should be confirmed with the user.

## UI
Mobile-first. Routes under `src/app/(app)/`.

- **`/sign-in`:** one "Sign in with Google" button. `src/proxy.ts` (Next 16 renamed middleware to proxy) sends signed-out users here, and allowlist rejections show a short error.
- **`/`:** the lists. Create, rename, delete with undo, and presence dots. On desktop it's a two-pane layout: a list sidebar beside the open list.
- **`/lists/[id]`:**
  - an add bar fixed to the bottom, with autocomplete and dedupe;
  - large tap targets to check items;
  - delete by swipe or menu, with an undo toast;
  - an item sheet: name, quantity stepper, notes, "Added by X · time" and "Updated by Y (via Claude) · time";
  - move to another list, and a "Clear checked / Uncheck all" menu;
  - an "editing…" badge on items the other person is editing.
- **Header:** an offline indicator with the number of pending changes, and a **Keep screen on** toggle. The toggle uses the Screen Wake Lock API, re-acquires the lock on `visibilitychange`, is remembered per device, and is hidden where the API isn't supported.
- **PWA:** `manifest.webmanifest` (standalone, icons, theme color), apple-touch-icon, safe-area insets.
- **Dark mode (#22):** follows the system setting; there's no toggle. The server-rendered `<head>` has `<meta name="color-scheme" content="light dark">`, and `:root` has `color-scheme: light dark`, so Safari's [Adaptive Dark Mode](https://webkit.org/blog/18541/introducing-adaptive-dark-mode/) leaves the app alone. Colors are CSS variables with light and dark values under `prefers-color-scheme`. `theme-color` is set for each scheme. Every UI change must work in both.
- Use the frontend-design skill when building the UI.

## Infra
- **Fly:** `fly.toml` with one shared-cpu machine, always on, and a volume at `/data`. The app name is not in `fly.toml` (the repo is public), so deploys use `-a <app>`. The entrypoint (`scripts/docker-entrypoint.sh`) runs as root only to give `/data` to the `node` user. It runs `litestream restore -if-db-not-exists -if-replica-exists`, then `litestream replicate -exec "node server.js"`. If the restore cannot reach R2, the machine stops, so a new volume never starts an empty database. `litestream.yml` points at an R2 bucket.
- **Migrations:** the server applies them at start, in `src/instrumentation.ts`, before the first request. Litestream accepts a database file that does not exist yet. `GET /api/health` (no auth) runs `select 1`.
- **Secrets:** Google client ID/secret, `BETTER_AUTH_SECRET`, `ALLOWED_EMAILS`, VAPID keys, `ANTHROPIC_API_KEY`, R2 credentials. They live in Fly secrets and `.env.local`, never in the repo or issues: both are public.
- **Cloudflare:** a proxied CNAME to Fly. The Fly certificate uses the ACME DNS challenge and the `_fly-ownership` TXT record, because the proxy hides Fly. The zone is shared with other hosts, so a Configuration Rule sets SSL Full (strict) for this host only, and a Cache Rule for this host bypasses the cache for `/api/*` and `/sw.js`. The service worker is served with `Cache-Control: no-cache`. Use the `cf` CLI with `--dry-run` first.
- **CI/CD (#24):** GitHub Actions runs the checks (format, lint, typecheck, unit and e2e tests, `npm audit`, unapproved install scripts) on each PR and on `main`. A green push to `main` runs `flyctl deploy --remote-only`, then the health check. `[skip deploy]` in the commit message skips the deploy. Results go to Slack through an incoming webhook. Each third-party action is pinned to a commit SHA, `FLY_API_TOKEN` goes only to the deploy step, and event values reach scripts only through `env:`. `PRODUCTION_URL` is a secret, because the repo is public. Migrations run at boot, not in a Fly `release_command`, because that machine has no volume.
- **Dependabot (#25):** weekly updates for npm, GitHub Actions (including the composite actions), and the Docker base images, with a short cooldown. Minor and patch updates are grouped. `allowScripts` pins `better-sqlite3`, so a bump of it needs a new approval.

**Biggest platform risk:** Google sign-in from an installed iOS PWA. OAuth redirects in standalone mode and cookies not being shared with Safari could break it, so #3 tests it before anything else builds on it.

## Verification
**Unit tests (vitest):**
- HLC ordering;
- field-level merge, including the offline-late-edit, delete-vs-edit and add-to-deleted-list cases;
- op idempotency;
- dedupe;
- `collapse` cases;
- template strings and a/an;
- the summarizer fallback path, with the SDK mocked.

**End-to-end tests (Playwright):**
- two browser contexts as two users: realtime updates within about 1s, and presence badges;
- `context.setOffline(true)`: make edits, go back online, confirm they reconcile, with conflicting edits on both sides;
- the undo toast;
- a non-allowlisted account being rejected (a test auth stub stands in for Google). The stub (`src/lib/auth-stub.ts`) runs through the same Better Auth path as the Google callback. The standalone server always sets `NODE_ENV=production`, so the stub needs `AUTH_STUB=1`, an http loopback `BETTER_AUTH_URL`, and no `FLY_APP_NAME`.

**MCP contract tests (vitest) against `/mcp`:**
- 405 on `GET`/`DELETE`;
- `HeaderMismatch` and `UnsupportedProtocolVersion`;
- `server/discover` shape;
- `resultType` on every result;
- deterministic `tools/list`;
- `structuredContent` that matches each `outputSchema`;
- `isError` for business errors;
- 401 with `resource_metadata`, and 403 `insufficient_scope`;
- a token for a different `aud` is rejected;
- CIMD fetch, including the SSRF guard;
- `iss` in authorization responses.

**MCP clients:** MCP Inspector (a version that supports 2026-07-28) for the full OAuth flow and every tool. Then connect from Claude.ai and Duet, and confirm that "add milk and eggs to Whole Foods" appears live in the app and triggers one grouped push attributed "via Claude".

**On a real device (installed iPhone PWA):** Google sign-in, push permission and delivery, deep links from notifications, the wake lock keeping the screen on, airplane-mode shopping and then sync.

**Ops:** run `fly deploy`, restore Litestream from R2 into a scratch machine, and confirm SSE stays open through Cloudflare past 100s.
