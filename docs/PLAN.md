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
| `processed_ops` | op_id, user_id, result (JSON), processed_at. It makes pushes idempotent: a retry gets the stored result. |
| `activity` | id, op_id, actor_id, via, type (the op type), list_id, item_id, snapshot (names at that moment), at, notified_at. Drives notifications. A partial index covers the rows with no `notified_at`. |
| `push_subscriptions` | id, user_id, endpoint (unique), p256dh, auth, device_label, enabled, created_at, last_success_at |
| `list_mutes` | user_id, list_id |
| `server_seq` | one global counter and `purged_seq` (one row, id 1, no seed row). Every write gets the next seq with `INSERT … ON CONFLICT (id) DO UPDATE SET value = value + 1 RETURNING value`. |

Better Auth uses `users`, `sessions`, `accounts`, and `verifications`. The OAuth server has its own tables.

Indexes: `seq` on `lists` and `items`, `(list_id, name_key)` and `name_key` on `items`. There is no unique index on `(list_id, name_key)`: a hard constraint can make a push fail on each retry (for example, a move or a restore into a list that has the same name). `applyOps` does the dedupe.

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

**`applyOps` results** (#5): each op gets `applied { changed }`, `merged { into, changed }`, `rejected { reason }`, or `duplicate { original }`. The reasons are `list_not_found`, `list_deleted`, `list_exists`, `item_not_found`, `item_exists`, and `clock_ahead` (the op HLC is more than 5 minutes after the server clock). `processed_ops` keeps the first result, also for a rejection, so a retry gets the same answer. An op that writes only clocks is `applied { changed: false }`: it gets no seq, no activity row and no poke. Each changed row gets its own seq, so a page of a pull never splits one seq. `updated_at` is the op time (the HLC wall time), not the server time. `activity.at` is the server time. An unexpected error rolls back the whole call.

**Op types:** createList, renameList, deleteList, restoreList, addItem, updateItem(fields), check, uncheck, deleteItem, restoreItem, moveItem, clearChecked, uncheckAll.

**Op format** (`src/shared/ops.ts`, zod): `{ opId, clientId, hlc, type, args }`. `opId` is a UUID. The node of `hlc` must be the `clientId`. Strings are trimmed. `addItem` sets `quantity: 1` and `notes: ""` by default. `updateItem` takes `fields` (name, quantity, notes) with at least one field. Limits: list name 100, item name 200, notes 2000, quantity 1–999. `clearChecked` and `uncheckAll` take only `listId`: #5 sets which items they change.

**HLC** (`src/shared/hlc.ts`): the form is `<15-digit ms>-<4 hex counter>-<node>`. A string comparison gives the same order as `compare()`, thus `clocks` can keep the strings. Ties break on the node (client ID). `receive()` refuses a remote time more than 5 minutes ahead of the local clock. `HlcClock` keeps the state; the client stores its `last` value to stay monotonic after a restart. Server writes (MCP) use a fixed node ID, for example `server`. `nameKey()` is in `src/shared/names.ts`.

**Client** (`src/client/sync/`):
- A change is written to Dexie optimistically and added to the outbox. The UI reads Dexie through `useLiveQuery`, so it works the same online and offline.
- Each sync cycle: push the outbox → pull rows with `seq > cursor` (tombstones included) → re-apply any ops still pending.
- Sync runs on startup, on `online`, on `visibilitychange` to visible, on an SSE `poke`, and after each local write (debounced).
- **Two layers** (#7): `serverLists`/`serverItems` hold the rows from the last pull. `lists`/`items` hold the view: the server rows with the pending ops on top. `mutate()` writes the op to the outbox and applies it to the view in one transaction. After each sync, `rebuildView()` makes the view again from the server rows and the outbox, so a rejected op goes away and a merged row is dropped. `src/client/sync/apply.ts` is the local copy of the merge rules, without clocks.
- The HLC state is in the Dexie `meta` table, and each write reads and updates it in its transaction, so two tabs never give the same HLC. A Web Lock lets only one tab sync at a time.
- Errors: a network or 5xx error retries with backoff (1s, doubled each time, 60s at most). A 400 drops the ops that are no longer valid under the current schema (a "rejected" event with reason `invalid`). A 401 stops until the next trigger and keeps the outbox.
- If a different user signs in on the same browser, the local data (outbox included) is deleted. The client ID and the clock stay.
- Code: `src/client/db.ts`, `src/client/sync/`, and the hooks in `src/client/hooks.ts`. `<SyncStarter>` in the `(app)` layout starts the engine.

**Endpoints** (#6; wire types in `src/shared/sync.ts`, logic in `src/server/sync.ts`):
- `POST /api/sync/push` takes `{ clientId, ops }`, with at most 200 ops and 1 MB. Each op must have the `clientId` of the push. Any bad input gets 400 and nothing is applied, so the client checks each op with `opSchema` before it goes in the outbox. A body that is not JSON gets 415, and a body that is too large gets 413. It returns `{ results, seq }`.
- `GET /api/sync/pull?since=<seq>&limit=<n>` (default 500, max 1000) returns `{ reset, lists, items, users, hlc, cursor, hasMore }`. Rows are in seq order, with tombstones. There are no clocks or emails. `hlc` is the largest field clock in the page: the client gives it to its `HlcClock`, so its next edit sorts after what it saw. After the last page, `cursor` is the last seq of the server.
- `reset: true` when `since` is below `purged_seq`, or above the last seq (the server database came from an older backup). The page then starts from seq 0, and the client deletes its lists and items (not its outbox) before it applies the page.
- Reads go through `src/server/queries.ts`.

**Conflict rules:**
- Concurrent edits to different fields both survive (e.g. one person checks an item while the other edits its notes).
- For the same field, the later edit wins.
- Delete vs. edit: the later timestamp wins. "deleted" is a field with its own clock: a delete writes true, and a restore or any edit (rename, check, move…) writes false. Thus the result is the same in each order of arrival, and a later edit brings a deleted row back.
- A list delete does not change its items. The client hides the items of a deleted list, and a restore brings them back.
- `clearChecked` deletes, and `uncheckAll` unchecks, the items whose check clock is older than the op. An item checked after the op stays.
- Item ops on an item in a deleted list are applied as usual. Only `addItem` and `moveItem` to a deleted list are rejected.
- Adding an item to a list that was deleted while you were offline is rejected. The client shows a toast offering to re-create the list.
- Tombstones are purged after 30 days (`purgeTombstones`). It also deletes the items of purged lists, `processed_ops` rows, and sent `activity` rows older than the limit. It sets `server_seq.purged_seq` to the largest seq that it deleted. A pull with a cursor below `purged_seq` must start again from 0 (#6).

**Offline auth:** if the session has expired, the outbox keeps queuing. On a 401, show "Sign in again to sync N changes" without dropping anything.

**Storage:** call `navigator.storage.persist()`. iOS has no Background Sync API, so syncing happens whenever the app is opened or comes back to the foreground.

**Dedupe:**
- `name_key` is the name lowercased and trimmed, with spaces collapsed.
- Adding a name that matches an item already on the list opens an "Already on the list. Uncheck it?" prompt. If the match is already unchecked, it offers to increase the quantity.
- The server never creates a second row with the same `name_key` on a list. It returns `merged`, and the client drops its local row.
- MCP `add_items` does the same automatically and reports what happened.
- The server dedupes only on `addItem`. A match is an item on the same list with the same `name_key` that is not deleted. If it is checked (and its check is older than the op), the server unchecks it. A deleted match does not count: the add makes a new row. A rename or a move can give two items with the same name.

**Autocomplete (#14):** suggests names from every item on the device (all lists, deleted items too), grouped by `name_key` (`src/client/suggest.ts`). A match at the start of the name comes first, then at the start of a word, then in the middle. In each group, the score is `log2(1 + count)` plus a recency term that halves every 14 days. The unchecked items of the current list, and an exact match, are left out. The add bar is an ARIA combobox: arrow keys and Enter pick, Escape closes, and a tap on a suggestion adds it.

**Dedupe prompt (#14):** before `mutate`, the add bar looks for a live item with the same `name_key` on the list. If it is checked: "Already on the list. Uncheck it?". If not: "Add N more?" (an `updateItem` of the quantity). A `merged` result from the server (two devices added the same name) shows a toast through the engine's `merged` event.

**Sorting:** unchecked first, then `updated_at` descending.

## Realtime and presence
- **`GET /api/events`:** an SSE stream.
  - A comment heartbeat every 20s keeps it under Cloudflare's 100s idle timeout.
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
  - Events: `poke {seq}` and `presence {userId, listId, editingItemId}`.
  - `Cache-Control: no-transform` also stops the gzip layer of Next.js, which can hold events in its buffer. The stream starts with `retry: 3000` and a comment, so it opens at once. Next.js aborts `request.signal` when the client goes, and the stream then removes its bus listener (#11).
  - Client (`src/client/realtime.ts`): one `EventSource`, open only while the page is visible. Each `poke`, and each (re)connection, starts a sync. After an HTTP error (for example, 401), the browser stops, and the client tries again after 5 s, doubled each time, up to 60 s. `startSync()` starts it.
- **`POST /api/presence`:** a heartbeat every 15s, and whenever your current view or editing target changes. The server keeps a 30s-TTL map in memory and broadcasts changes. Presence is hidden while offline.
  - Built in #12. Body: `{ clientId, listId, editingItemId }` (`src/shared/presence.ts`); both null means the device left. The store (`src/server/presence.ts`) keys each entry by user and device, sweeps every 5 s, and broadcasts the full snapshot as the `presence` SSE event on each change. A new stream gets the snapshot first.
  - Client (`src/client/presence.ts`): `useReportPresence()` in the list view sends changes at once, a heartbeat every 15 s while a list is open, and a clear on unmount, on hide, and on `pagehide`. Safari sends no clear for a full page load: the TTL removes it. The other people's presence is cleared whenever the stream is closed, so it is hidden offline.
  - UI: avatar dots on list rows (`ListViewers`) and "Name is editing…" on item rows (`EditingBadge`), in `src/app/(app)/_components/presence.tsx`.

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

**Built in #15:**
- `/settings` (a link in the header; sign out moved there too). "This device": the Enable button, or why it can't (no server keys, Safari on iPhone/iPad outside the Home Screen app, blocked, unsupported). "Your devices": an on/off switch and Remove for each, and "Send a test notification". "Lists": a switch for each list (`list_mutes`).
- API: `GET/POST /api/push/subscriptions`, `PATCH/DELETE /api/push/subscriptions/<id>`, `POST /api/push/test`, `GET/PUT /api/push/mutes`. The endpoint is unique: a browser that subscribes again replaces its row.
- `src/server/push.ts`: `sendToUser(userId, payload)` sends to the enabled devices with a 24 h TTL, deletes a subscription on 404 or 410, and sets `last_success_at`. Keys come from `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. The subject is `VAPID_SUBJECT`, or the app origin, so no email is needed. Without keys, nothing is sent.
- The service worker shows the payload (`PushPayload`: title, body, url, tag). A tap focuses a window of the app on that URL, or opens one. Only same-origin URLs are used.

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
- **Shell (#8):** `src/app/(app)/layout.tsx`. The header (app name, sync status, avatar, sign out) is sticky, and every edge has the safe-area insets (`viewportFit: "cover"`). At `lg` and wider, the lists are a sidebar; `/` then shows a prompt to pick a list. Each list row has a "More" button with Rename (inline form) and Delete (a `<dialog>` to confirm). Components are in `src/app/(app)/_components/`.
- **`/lists/[id]`:**
  - an add bar fixed to the bottom, with autocomplete and dedupe;
  - large tap targets to check items;
  - delete by swipe or menu, with an undo toast;
  - an item sheet: name, quantity stepper, notes, "Added by X · time" and "Updated by Y (via Claude) · time";
  - move to another list, and a "Clear checked / Uncheck all" menu;
  - built in #13: a "List actions" menu beside the `h1` (rename, uncheck all, clear checked items with a confirmation, delete list) and "Move to" in the item sheet. Each delete, move, and bulk action shows a toast with Undo for 5 s (`src/client/toasts.ts`, `_components/toaster.tsx`). Undo sends `restoreItem`, `restoreList`, `moveItem` back, or one `restoreItem`/`check` for each item that the bulk op changed. The toaster also shows each change that the server refused.
  - an "editing…" badge on items the other person is editing.
  - Built in #9 (`src/app/(app)/lists/[id]/`): each row is one large `role="checkbox"` button with an Edit button beside it. The add bar is sticky at the bottom, with quantity and notes behind "Details". The sheet is a `<dialog>`: a bottom sheet on a phone, centered at `lg`. It takes focus itself, so the keyboard does not open. Delete is in the sheet; swipe-to-delete is not built. Forms clear before the write, so fast entry keeps each item.
- **Header:** an offline indicator with the number of pending changes, and a **Keep screen on** toggle. The toggle uses the Screen Wake Lock API, re-acquires the lock on `visibilitychange`, is remembered per device, and is hidden where the API isn't supported.
- **PWA:** `manifest.webmanifest` (standalone, icons, theme color), apple-touch-icon, safe-area insets.
- **Service worker (#10):** Serwist. `src/sw/sw.ts` (its own `tsconfig.json` with the `webworker` lib). `scripts/build-sw.mjs` runs after `next build`: it calls the `@serwist/turbopack` route handler one time and writes `public/sw.js`. Thus the server and the Docker image need no esbuild and no source at runtime (a route handler is dynamic under Cache Components, and would bundle at the first request). `/sw.js` has `Cache-Control: no-cache` and scope `/`.
  - Caching: the precache has the build assets and `/~offline`. Pages and RSC payloads are network first, then the cache (`defaultCache`). `/api/*` never goes through the worker: a first `fetch` listener stops the Serwist listeners, so sync sees the server and SSE stays native.
  - `/` is not precached: without a session it redirects, and that can fail the install. Instead `src/app/service-worker.tsx` asks the worker to cache each page that the app shows (`CACHE_URLS`), also the first one. A page never opened online gets `/~offline`.
  - Update: `skipWaiting` and `clientsClaim`. When a new worker takes control, a "new version" prompt offers a reload.
  - Registration is production only. The `(app)` layout mounts it.
- **Dark mode (#22):** follows the system setting; there's no toggle. The server-rendered `<head>` has `<meta name="color-scheme" content="light dark">`, and `:root` has `color-scheme: light dark`, so Safari's [Adaptive Dark Mode](https://webkit.org/blog/18541/introducing-adaptive-dark-mode/) leaves the app alone. Colors are CSS variables with light and dark values under `prefers-color-scheme`, mapped to Tailwind tokens with `@theme inline` in `src/app/globals.css`: `canvas`, `surface`, `ink`, `ink-muted`, `line`, `accent`, `accent-ink`, `accent-soft`, `danger`. Light is pale leaf-gray with market green; dark is a grocer's chalkboard with leaf green. Every text pair is at least 5.9:1. `e2e/theme.spec.ts` runs axe in both schemes. `theme-color` is set for each scheme. Every UI change must work in both.
- Use the frontend-design skill when building the UI.

## Infra
- **Fly:** `fly.toml` with one shared-cpu machine, always on, and a volume at `/data`. The app name is not in `fly.toml` (the repo is public), so deploys use `-a <app>`. The entrypoint (`scripts/docker-entrypoint.sh`) runs as root only to give `/data` to the `node` user. It runs `litestream restore -if-db-not-exists -if-replica-exists`, then `litestream replicate -exec "node server.js"`. If the restore cannot reach R2, the machine stops, so a new volume never starts an empty database. `litestream.yml` points at an R2 bucket.
- **Migrations:** the server applies them at start, in `src/instrumentation.ts`, before the first request. Litestream accepts a database file that does not exist yet. `GET /api/health` (no auth) runs `select 1`.
- **Secrets:** Google client ID/secret, `BETTER_AUTH_SECRET`, `ALLOWED_EMAILS`, VAPID keys, `ANTHROPIC_API_KEY`, R2 credentials. They live in Fly secrets and `.env.local`, never in the repo or issues: both are public.
- **Cloudflare:** a proxied CNAME to Fly. The Fly certificate uses the ACME DNS challenge and the `_fly-ownership` TXT record, because the proxy hides Fly. The zone is shared with other hosts, so a Configuration Rule sets SSL Full (strict) for this host only, and a Cache Rule for this host bypasses the cache for `/api/*` and `/sw.js`. The service worker is served with `Cache-Control: no-cache`. Use the `cf` CLI with `--dry-run` first.
- **CI/CD (#24):** GitHub Actions runs the checks (format, lint, typecheck, unit and e2e tests, `npm audit`, unapproved install scripts) on each PR and on `main`. A green push to `main` runs `flyctl deploy --remote-only`, then the health check. `[skip deploy]` in the commit message skips the deploy. Results go to Slack through an incoming webhook. Each third-party action is pinned to a commit SHA, `FLY_API_TOKEN` goes only to the deploy step, and event values reach scripts only through `env:`. `PRODUCTION_URL` is a secret, because the repo is public. Migrations run at boot, not in a Fly `release_command`, because that machine has no volume.
- **Dependabot (#25):** weekly updates for npm, GitHub Actions (including the composite actions), and the Docker base images, with a short cooldown. Minor and patch updates are grouped. `allowScripts` pins `better-sqlite3`, so a bump of it needs a new approval. `esbuild` and `fsevents` are denied: they work without their install scripts.

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
