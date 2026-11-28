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
- **Notifications:** pushes are grouped per burst (~60s window). Claude Sonnet 5.5 at low effort (#106: Opus 5.5 was more than the task needs) writes one sentence for the burst, also for a single change (#89), with a fixed template as the fallback.
- **Agent edits:** recorded as the user, with a "via Claude" tag (e.g. "Sam (via Claude) added …"). Only the other person is notified.
- **v1 extras:** bulk reset (clear checked / uncheck all), autocomplete and dedupe, undo for deletes, rename list, move item between lists.
- **Presence:** an avatar dot on lists the other person has open, and an "editing…" badge on the item they are editing.
- **MCP:** a remote MCP server that follows spec 2026-07-28, using OAuth 2.1 (Client ID Metadata Documents first, with DCR as a fallback) behind the same Google allowlist. No personal access tokens.
- **Notification preferences:** push on/off per device, and mute per list.
- **Claude Duet:** it uses the connected apps on the Claude account. It's a proactive agent that runs in the cloud and asks for approval before deleting anything. The same remote MCP connector works for Claude.ai (web, Desktop, mobile), Claude Code and Duet. Duet's needs are covered in [MCP](#mcp): long-lived tokens, tool annotations, and safe retries.

### Notification templates
The fallback text, when Claude gives none (#89). Each sentence ends with a period.
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
- “[Name] marked “[item]” as out of stock in the “[list]” list” (#131)
- “[Name] marked “[item]” as in stock in the “[list]” list” (#131)

When the change came over MCP, "[Name]" becomes "[Name] (via Claude)".

The sentences are in the dictionary (`push.events` in `src/copy/en.ts`, #66). `src/server/notify/templates.ts` fills in the values.

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
- @serwist/turbopack (the service worker build, see Service worker)
- web-push
- @anthropic-ai/sdk
- zod
- @modelcontextprotocol/server v2 (decided in #19, see MCP)
- better-auth plugins for the MCP OAuth server: `@better-auth/mcp`, `@better-auth/cimd`, `@better-auth/oauth-provider`; jose
- vitest, playwright

## Data model
Schema in `src/db/schema.ts`.

| Table | Columns / purpose |
|---|---|
| `users` | id, email, name (Google given name), avatar_url |
| `lists` | id (UUID generated on the client), name, created_by/at, updated_by/at, updated_via (`app` \| `mcp`), deleted_at, tombstoned_at (server time of the delete, #101), clocks (JSON), summary and summary_key (see List summaries), seq |
| `items` | id (UUID), list_id, name, name_key (normalized for dedupe), quantity (int, default 1), notes, url (an http or https URL, or empty, #140), checked, checked_at, out_of_stock_at (the op time of the mark, or null, #131), created_by/at, updated_by/at, updated_via, deleted_at, tombstoned_at, clocks (JSON, one HLC timestamp per field), seq |
| `processed_ops` | op_id, user_id, result (JSON), processed_at (server time). It makes pushes idempotent: a retry gets the stored result. The purge keeps the rows for 180 days (#119). |
| `activity` | id, op_id, actor_id, via, type (the op type; a `moveItem` that does not change the list only restores the item, thus its row is a `restoreItem` on the list of the item, #118), list_id, item_id, snapshot (names at that moment; for an update, also the fields that changed (`name`, `quantity`, `notes`, `url`); `unchecked` and `inStock` when the change also unchecked the item or marked it in stock, #112, #131; an add of a name that is checked on the list has `unchecked`, #133; the values for collapse, #133: see Notifications), at, notified_at. A bulk op (`clearChecked`, `uncheckAll`, `checkAll`) writes one row for each item that it changed, with the op type and the item (#133; older rows: one row with `count` and no item). Drives notifications. A partial index covers the rows with no `notified_at`. |
| `push_subscriptions` | id, user_id, endpoint (unique), p256dh, auth, device_label, enabled, created_at, last_success_at, failure_count, failing_since, last_failure_at (#118) |
| `list_mutes` | user_id, list_id |
| `server_seq` | one global counter and `purged_seq` (one row, id 1, no seed row). Every write gets the next seq with `INSERT … ON CONFLICT (id) DO UPDATE SET value = value + 1 RETURNING value`. |

Better Auth uses `users`, `sessions`, `accounts`, and `verifications`. The OAuth server has its own tables.

Indexes: `seq` on `lists` and `items`, `(list_id, name_key)` and `name_key` on `items`. There is no unique index on `(list_id, name_key)`: a hard constraint can make a push fail on each retry (for example, a move or a restore into a list that has the same name). `applyOps` does the dedupe.

**Allowlist:** the `ALLOWED_EMAILS` environment variable. Better Auth's `user.validateUserInfo` rejects any other email before a user row is created. It checks again at each Google sign-in. `getCurrentUser` also treats a session for an email that is no longer in the list as signed out. A `hooks.before` rule (`src/lib/auth.ts`, #116) refuses such a session (403) on each `/api/auth/*` path, for example the approval of an OAuth client. Only the sign-in flow, `get-session`, and `sign-out` accept it.

**Disabled endpoints** (#116): `DISABLED_PATHS` in `src/lib/auth.ts` turns off each Better Auth endpoint that the app does not use: they give 404. For example `/update-user` (the name and the avatar come only from Google), the email and password endpoints, the account and session lists, the client and consent management endpoints (`/oauth2/create-client`, `/oauth2/get-clients`, `/oauth2/update-consent`, …), and the OpenID Connect endpoints. The server code can still call them through `auth.api`.

**Sessions:** long and rolling (~180 days), because re-authenticating inside an iOS PWA is awkward. Server Components cannot set cookies, so they read the session with `disableRefresh`. `<SessionRefresh>` calls `/api/auth/get-session` when the app opens or comes to the front, and that call extends the session and the cookie.

## Sync design
**One mutation pipeline for everyone.** UI, sync and MCP all call `applyOps(actor, via, ops[])` in `src/server/ops.ts`. It runs in one SQLite transaction and:
1. skips op_ids already in `processed_ops`;
2. merges each op field by field, last-writer-wins by HLC timestamp. A field is written only if the op's timestamp is newer than that field's clock;
3. bumps seq and sets updated_by/at/via;
4. writes `activity` rows;
5. emits `poke` on the in-process bus.

Because of this, realtime updates, notifications and attribution behave the same whether a change comes from the app or from Claude. There are three exceptions, all with no actor: `setListSummary` (List summaries: the server makes the summary from the items), `expireCheckedItems` (Checked-item expiry, #112), and `purgeTombstones` (the purge: it deletes old rows, and makes the live items of an old deleted list tombstones, #119).

**`applyOps` results** (#5): each op gets `applied { changed }`, `merged { into, changed }`, `rejected { reason }`, or `duplicate { original }`. The reasons are `list_not_found`, `list_deleted`, `list_exists`, `item_not_found`, `item_exists`, `clock_ahead` (the op HLC is more than 5 minutes after the server clock), and `op_conflict` (#101: a `processed_ops` row with this opId belongs to a different user; the first result stays, and nothing is stored for the second user). `clearChecked`, `uncheckAll`, and `checkAll` put the number of items that they changed in `applied.count`, and `deleteList` the number of live items of the list. The MCP tools report these counts, also on a retry. `processed_ops` keeps the first result, also for a rejection, so a retry gets the same answer. An op that writes only clocks is `applied { changed: false }`: it gets no seq, no activity row and no poke. Each changed row gets its own seq, so a page of a pull never splits one seq. `updated_at` is the op time (the HLC wall time), not the server time. `activity.at` is the server time. An unexpected error rolls back the whole call.

**Op types:** createList, renameList, deleteList, restoreList, addItem, updateItem(fields), check, uncheck, deleteItem, restoreItem, moveItem, clearChecked, uncheckAll, checkAll (#67), markOutOfStock, markInStock (#131).

**Op format** (`src/shared/ops.ts`, zod): `{ opId, clientId, hlc, type, args }`. `opId` is a UUID. The node of `hlc` must be the `clientId`. Strings are trimmed. `addItem` sets `quantity: 1`, `notes: ""`, and `url: ""` by default. `updateItem` takes `fields` (name, quantity, notes, url) with at least one field. Limits: list name 100, item name 200, notes 2000, URL 2000, quantity 1–999. A URL must be `http` or `https` with a host (`isWebUrl()` in `src/shared/url.ts`, #140), or empty (no link): the app opens it in a new tab, thus a `javascript:` URL must never get in. `clearChecked`, `uncheckAll`, and `checkAll` take only `listId`: #5 sets which items they change.

**HLC** (`src/shared/hlc.ts`): the form is `<15-digit ms>-<4 hex counter>-<node>`. A string comparison gives the same order as `compare()`, thus `clocks` can keep the strings. Ties break on the node (client ID). `receive()` refuses a remote time more than 5 minutes ahead of the local clock. `HlcClock` keeps the state; the client stores its `last` value to stay monotonic after a restart. Server writes (MCP) use a fixed node ID, for example `server`. `nameKey()` is in `src/shared/names.ts`.

**Client** (`src/client/sync/`):
- A change is written to Dexie optimistically and added to the outbox. The UI reads Dexie through `useLiveQuery`, so it works the same online and offline.
- Each sync cycle: push the outbox → pull rows with `seq > cursor` (tombstones included) → re-apply any ops still pending.
- Sync runs on startup, on `online`, on `visibilitychange` to visible, on an SSE `poke`, and after each local write (debounced).
- **Two layers** (#7): `serverLists`/`serverItems` hold the rows from the last pull. `lists`/`items` hold the view: the server rows with the pending ops on top. `mutate()` writes the op to the outbox and applies it to the view in one transaction. After each sync, `rebuildView()` makes the view again from the server rows and the outbox, so a rejected op goes away and a merged row is dropped. `src/client/sync/apply.ts` is the local copy of the merge rules, without clocks. As on the server, an op that changes no field (for example, a check of a checked item) does not change `updatedAt` or `updatedBy` (#115).
- The HLC state is in the Dexie `meta` table, and each write reads and updates it in its transaction, so two tabs never give the same HLC. A Web Lock lets only one tab sync at a time.
- Errors: a network error, or a status that is not 200, 400, 401, or 413 (5xx, and also 403, 404, 415, 429), retries with backoff (1s, doubled each time, 60s at most). No status drops the outbox: a 403 or a 404 can come from a proxy or a deploy, and goes away (#115). Each request has a 30 s timeout (`AbortSignal.timeout`), and a timeout is a network error, thus a hung connection does not keep the Web Lock (#99). A 400 drops the ops that are no longer valid under the current schema (a "rejected" event with reason `invalid`). A 413, or a 400 where each op passes the local schema, makes the next batch half as large; a batch of one op that gets such an error drops the op as `invalid`. Thus one bad op does not block the ops after it. A 401 stops until the next trigger and keeps the outbox. A run does at most 50 pushes; if ops are still pending after them, it schedules a new run at once (#115).
- After a push that changed the outbox, `rebuildView()` runs also when the pull fails, so a rejected op leaves no ghost row (#99). An applied op stays in the outbox as `acked` until a pull succeeds (#103): the engine does not push it again, the pending count does not show it, and the view keeps it. Without this, a pull that failed after a good push (for example, a reload) removed the new change from the view until the next pull.
- Clock offset (#115): each push and pull response has `now`, the server time. The client keeps `now - Date.now()` in `meta` (`clockOffset`), and its clock is `Date.now() + clockOffset`. A slow or fast device then stamps its ops with the server time. Without this, a device 10 minutes slow saw the HLC of a pull as more than 5 minutes ahead, started its clock again from the device time, and its next edit lost to the change it had just seen, with no toast.
- Clock ahead (#99): if the stored HLC is more than 5 minutes after the client clock (the device clock plus the offset), the client starts its clock again from it when it loads it. An op with a `clock_ahead` rejection gets a new opId and a new HLC one time, at the server time (`now` in the push response) if the device clock is after it, and keeps its place in the outbox. A second `clock_ahead` drops it.
- Item sheet (#99): a save sends only the fields that the user changed since the sheet opened, thus it keeps a rename or a notes edit by the other person. Each open of the sheet makes a new form (#140): before, a second open of the same item kept the form of the first open, and a save compared the fields with the old values (for example, a URL that the user removed was not sent). If the item leaves the list while the sheet is open (a delete or a move on another device), the sheet closes with a toast and does not save.
- The header shows an error state when a sync fails, also with no pending changes. Its `role="status"` element stays in the DOM.
- The sync status in the header is a cloud icon (`syncIndicator` in `src/client/sync-indicator.ts`): `cloud-arrow-up` for changes to sync (it fades while a sync runs), `cloud-slash` offline, and a red `cloud-exclamation` for an error or a session that ended (a link to sign-in). It shows no count. Its text is only for a screen reader. The online state shows only after it stays for 2 s, thus a fast sync after each save does not flash. Before, the text made the header wrap on a phone.
- If a different user signs in on the same browser, the local data (outbox included) is deleted. The client ID and the clock stay. The user ID of `<SyncStarter>` can come from a page in the cache (#103), thus `startSync()` checks the session first (`/api/auth/get-session`) when the stored user is different. If the session does not show the new user (for example, offline), nothing is deleted and sync does not start; it tries again at `online`, and also on a timer while the browser is online (5 s, doubled each time, 5 min at most), because get-session can fail with no `online` event after it (#115). `mutate()` waits until `startSync()` knows if the data stays or the check fails. Each outbox entry keeps the user of the page that made it (`userId`), and a reset keeps the entries of the new user and makes the view again from them. Thus a reset never deletes a new write (#115). An entry with no `userId` (from an older version) belongs to the stored user.
- Sign-out (#103): before the server sign-out, the browser syncs if it is online. `sync()` does not reject on an error, thus the client then counts the ops that the server does not have (#115). If there are some, a dialog asks first ("Sign out with changes that didn’t sync?"), and Cancel keeps everything. Then the browser stops sync, deletes the push subscription (in the browser and its row on the server), deletes the runtime caches of the service worker (the precache stays), and deletes the local data and the stored user. The worker deletes the caches (a `CLEAR_PAGES` message, #119): a fetch of the worker that started before it, for example the list shell of a `CACHE_URLS` message, does not put a page back (`pageCachePlugin` in `src/sw/page-cache.ts`). The client ID and the clock stay (`src/client/sign-out.ts`).
- Code: `src/client/db.ts`, `src/client/sync/`, and the hooks in `src/client/hooks.ts`. `<SyncStarter>` in the `(app)` layout starts the engine.

**Endpoints** (#6; wire types in `src/shared/sync.ts`, logic in `src/server/sync.ts`):
- `POST /api/sync/push` takes `{ clientId, ops }`, with at most 200 ops and 1 MB. Each op must have the `clientId` of the push. Any bad input gets 400 and nothing is applied, so the client checks each op with `opSchema` before it goes in the outbox. A body that is not JSON gets 415, and a body that is too large gets 413. It returns `{ results, seq, now }` (`now` is the server time).
- `GET /api/sync/pull?since=<seq>&seen=<purgedSeq>&limit=<n>` (default 500, max 1000) returns `{ reset, lists, items, users, hlc, cursor, hasMore, purgedSeq, now }` (`now` is the server time, #115). Rows are in seq order, with tombstones. There are no clocks or emails. `hlc` is the largest field clock in the page: the client gives it to its `HlcClock`, so its next edit sorts after what it saw. After the last page, `cursor` is the last seq of the server.
- `reset: true` when `since` is below `purged_seq` and `seen` is below `purged_seq` too, or when `since` is above the last seq (the server database came from an older backup). The page then starts from seq 0. The client does not clear its server layer at the reset page (#115): if page 2 failed, `rebuildView()` then removed each row that page 1 did not have, and the rows stayed gone offline. A `resetting` entry in `meta` keeps the IDs of the rows that the pages of the reset gave. After the last page, the client deletes the server rows that are not in it, and deletes the entry. A failed page keeps the entry, and the next pull continues the reset (it sends `seen`, thus it gets no new reset). The outbox stays. The client keeps `purgedSeq` of each page in `meta` and sends it as `seen` (#99). Thus page 2 of a reset, whose `since` is still below `purged_seq`, does not reset again. A client that sends no `seen` resets as before.
- Reads go through `src/server/queries.ts`.

**Conflict rules:**
- Concurrent edits to different fields both survive (e.g. one person checks an item while the other edits its notes).
- For the same field, the later edit wins.
- Delete vs. edit: the later timestamp wins. "deleted" is a field with its own clock: a delete writes true, and a restore or any edit (rename, check, move…) writes false. Thus the result is the same in each order of arrival, and a later edit brings a deleted row back.
- A list delete does not change its items. The client hides the items of a deleted list, and a restore brings them back.
- `clearChecked` deletes, and `uncheckAll` unchecks, the items whose check clock is older than the op. An item checked after the op stays. `checkAll` checks the unchecked items whose check clock is older than the op. An item unchecked or added after the op stays unchecked. The app shows `clearChecked` as "Delete checked items".
- Item ops on an item in a deleted list are applied as usual. Only `addItem` and `moveItem` to a deleted list are rejected.
- Adding an item to a list that was deleted while you were offline is rejected. The client shows a toast offering to re-create the list (built in #104, `src/client/recreate.ts`): "Re-create list" makes a new list with the same name, then adds the item to it (or moves it, for a `moveItem`), and opens it if the page of the deleted list is open. The refused adds and moves are grouped by the deleted list (#120): they wait 300 ms, then one toast shows for each list ("so 3 items weren't added"), and its action makes one new list with all the items. An add of the same name, or the same op two times, counts one time. A refused op that comes while the toast of its list is open replaces the toast with one for all the ops. If the deleted list is not on this device, one general toast shows for the group. It is a new list, not a restore: a restore brings back each item that the other person deleted with the list. A reason that the app does not know gets a general text.
- **Checked-item expiry (#112):** a checked item that nobody unchecks for 30 days is deleted. The time starts at `checkedAt`. `expireCheckedItems()` in `src/server/ops.ts` runs each hour (from `startPurger`, first 5 minutes after boot). It gives each row the server HLC as its delete clock, the server time in `deleted_at` and `tombstoned_at`, and a new seq, then pokes. It writes no `processed_ops` and no `activity` rows, thus no push. After the delete, the normal tombstone purge starts. An uncheck, an edit (name, quantity, or notes), or a move to another list unchecks the item and resets the time: on the server, only if the op changed the item and its HLC is newer than the check clock; the client (`apply.ts`) does the same without clocks. The activity snapshot of such an edit or move has `unchecked: true`, and `collapse()` treats it as an uncheck. The rules and the calendar-day math are in `src/shared/expiry.ts`. Known limits:
  - An uncheck made offline in the last hours can arrive after the job. Its HLC is older than the delete, thus the item stays deleted.
  - The Undo of a move does not check the item again.
  - `checkedAt` is the op time (the client clock). A check made offline arrives with its own time, thus an item checked offline 25 days ago expires about 5 days after it arrives. A device with a clock that is far behind gives an old `checkedAt`, and the item can expire early (#99 refuses only a clock that is ahead). The clock offset of #115 corrects this after the first push or pull of the device.
- **Out of stock (#131):** the store did not have the item. `out_of_stock_at` has its own field clock (`outOfStock`), as the other fields. `markOutOfStock` sets it (it keeps the first time), and `markInStock` clears it. Each one is an edit: it brings a deleted item back. Rules (the owner's decisions):
  - A checked item is never out of stock. A `check` writes "in stock" at its HLC when the HLC is newer than the stock clock, also when the check changes nothing else. `markOutOfStock` writes "unchecked" at its HLC when the HLC is newer than the check clock (the item is still to buy). Each op writes both fields at one HLC, thus the merge is per-field last-writer-wins, and the result is the same in each order of arrival: never "checked and out of stock". `checkAll` marks each item that it checks in stock.
  - A move to another list marks the item in stock (only when it changed the list, as the uncheck of #112): the person moves it to get it at a different store, and does not know if that store has it. A copy is a new `addItem`, thus it starts in stock. A merge into an item on the target list does not change its stock state.
  - An edit (name, quantity, notes) does not change it.
  - The activity snapshot of a check or a move that marked the item in stock has `inStock: true`; a mark that unchecked has `unchecked: true`.
  - The client (`apply.ts`) does the same without clocks. A row from an older server has no `outOfStockAt`: the client reads it as null.
- Tombstones are purged 30 days after the server wrote the delete (`purgeTombstones` in `src/server/purge.ts`). The server runs it 5 minutes after boot, then each day (#20). `deleted_at` is the op time (the client clock), thus #101 added `tombstoned_at` to `lists` and `items`: the server time of the delete, cleared by a restore. Thus a delete that comes late stays for the full 30 days. Migration `0006` set it to the migration time for the tombstones that were there. It also deletes sent `activity` rows older than the limit. It sets `server_seq.purged_seq` to the largest seq that it deleted. A pull with a cursor below `purged_seq` must start again from 0 (#6).
  - A deleted list goes only when each of its items is an old tombstone too (#119). The items of a deleted list can change (Conflict rules), thus they can have a recent seq, and a purge that deleted them moved `purged_seq` to that seq: each client then reset. Thus the purge makes each live item of an old deleted list a tombstone, as `expireCheckedItems` does (`tombstoneItems` in `src/server/ops.ts`: the server HLC as the delete clock, the server time in `deleted_at` and `tombstoned_at`, a new seq, and a poke; no `processed_ops`, no `activity`). A run 30 days later deletes the items and the list.
  - `processed_ops` rows stay for 180 days (`KEEP_OPS_DAYS`, #119), not 30. The client keeps an op in its outbox until the server answers (no status drops it, #115), also for a long time offline. If the response of a push was lost and the device sent the op again after the purge of its row, the server applied it again: an old `addItem` made an item again that someone had deleted. `processed_at` is the server time of `applyOps`. Known limit: a retry after more than 180 days is applied again.

**Offline auth:** if the session has expired, the outbox keeps queuing. On a 401, show "Sign in again to sync N changes" without dropping anything.

**Storage:** call `navigator.storage.persist()`. iOS has no Background Sync API, so syncing happens whenever the app is opened or comes back to the foreground.

**Dedupe:**
- `name_key` is the name lowercased and trimmed, with spaces collapsed.
- Adding a name that matches an item already on the list opens an "Already on the list. Uncheck it?" prompt. If the match is already unchecked, it offers to increase the quantity.
- The server never creates a second row with the same `name_key` on a list. It returns `merged`, and the client drops its local row. The later ops on the local row go to the merged item, in the same transaction (#115). An op that was in the same push got `item_not_found`, and the server keeps that result for its opId, thus it gets a new opId. An op that was not pushed yet keeps its opId. Thus an offline "add Milk, set notes 2%" keeps the notes when the other person added Milk first. A `duplicate` of a `merged` result also sends the `merged` event: the entry is still in the outbox, thus the first response did not arrive.
- MCP `add_items` does the same automatically and reports what happened.
- The server dedupes only on `addItem`. A match is an item on the same list with the same `name_key` that is not deleted. If it is checked (and its check is older than the op), the server unchecks it. A deleted match does not count: the add makes a new row. A rename or a move can give two items with the same name.

**Autocomplete (#14):** suggests names from every item on the device (all lists, deleted items too), grouped by `name_key` (`src/client/suggest.ts`). A match at the start of the name comes first, then at the start of a word, then in the middle. In each group, the score is `log2(1 + count)` plus a recency term that halves every 14 days. The unchecked items of the current list, and an exact match, are left out. The add bar is an ARIA combobox: arrow keys and Enter pick, Escape closes, and a tap on a suggestion adds it.

**Dedupe prompt (#14):** before `mutate`, the add bar looks for a live item with the same `name_key` on the list. The form keeps the name, quantity, and notes until the user confirms, thus Cancel loses nothing (#104). If it is checked: "Already on the list. Uncheck it?". The confirm sends an `uncheck`, then an `updateItem` for the quantity and the notes that the user typed (#120): only the fields that are not the defaults (quantity 1, empty notes) and that are different from the item. The prompt tells these changes. If not: "Add N more?" (an `updateItem` of the quantity). The form clears before the write. If the local write fails (for example, the disk is full), a toast tells the user to add the item again. A `merged` result from the server (two devices added the same name) shows a toast through the engine's `merged` event.

**Sorting:** unchecked first, then `updated_at` descending.

## Realtime and presence
- **`GET /api/events`:** an SSE stream.
  - A comment heartbeat every 20s keeps it under Cloudflare's 100s idle timeout.
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
  - Events: `poke {seq}` and `presence { entries: [{ userId, clientId, listId, editingItemId }] }`.
  - A stream closes after 15 minutes (#100). The browser connects again, and the route checks the session and the allowlist again. Thus a user who is removed from `ALLOWED_EMAILS` loses the stream within 15 minutes.
  - `Cache-Control: no-transform` also stops the gzip layer of Next.js, which can hold events in its buffer. The stream starts with `retry: 3000` and a comment, so it opens at once. Next.js aborts `request.signal` when the client goes, and the stream then removes its bus listener (#11).
  - Client (`src/client/realtime.ts`): one `EventSource`, open only while the page is visible. Each `poke`, and each (re)connection, starts a sync. After an HTTP error (for example, 401), the browser stops, and the client tries again after 5 s, doubled each time, up to 60 s. `startSync()` starts it.
- **`POST /api/presence`:** a heartbeat every 15s, and whenever your current view or editing target changes. The server keeps a 30s-TTL map in memory and broadcasts changes. Presence is hidden while offline.
  - Built in #12. Body: `{ clientId, listId, editingItemId }` (`src/shared/presence.ts`); both null means the device left. The store (`src/server/presence.ts`) keys each entry by user and device, sweeps every 5 s, and broadcasts the full snapshot as the `presence` SSE event on each change. A new stream gets the snapshot first. It keeps at most 10 devices for each person (#116): a new device over the limit removes the device of that person with the oldest heartbeat.
  - Client (`src/client/presence.ts`): `useReportPresence()` in the list view sends changes at once, a heartbeat every 15 s while a list is open, and a clear on unmount, on hide, and on `pagehide`. Safari sends no clear for a full page load: the TTL removes it. The other people's presence is cleared whenever the stream is closed, so it is hidden offline.
  - UI: avatar dots on list rows (`ListViewers`) and "Name is editing…" on item rows (`EditingBadge`), in `src/app/(app)/_components/presence.tsx`.

## Notifications
Code in `src/server/notify/`.

**Worker:** an in-process interval (~10s) scans for `activity` rows with no `notified_at`. It groups the rows per actor and `via` (`app` or `mcp`), because "(via Claude)" is for all of the text. It sends a group once it has had no new row for 60s, or 3 minutes after its first row at most. It marks the rows as sent, then makes one push for each recipient from the rows of the group (see Recipients), after `collapse()`. Pending state lives in the database, so a restart loses nothing.

**Recipients:** every user except the actor who is still in `ALLOWED_EMAILS` (#100). Muted lists are left out per recipient, and so are disabled devices. A recipient with no enabled device, or a server with no VAPID keys, gets no text and thus no Claude call (`canPushTo()`, #118).

**`collapse.ts`:** cancels out changes that add up to nothing.
- Check then uncheck → nothing. An edit or a move that unchecked (#112) counts as the uncheck, and so does a mark out of stock that unchecked (#131) and an add of a name that is checked on the list (#133).
- Out of stock then in stock (or the other way) → nothing (#131). A check or a move that marked the item in stock counts as the "in stock"; the check or the move stays. Add then out of stock → "added" and "marked out of stock".
- If the event that tells an uncheck or an "in stock" cancels out, but the state change stays, collapse gives "unchecked" or "marked in stock" (#133). For example: an edit that unchecked, then an edit back; a move that unchecked, then a move back; a check of an out of stock item, then an uncheck.
- Add then delete, including an undone delete → nothing.
- Add then update → "added".
- Several updates → one update, with only the fields that end at a different value. Updates that all end at their first value → nothing (#133).
- An item or a list that is not there at the start and at the end of the burst (new or deleted before, and deleted at the end) → nothing. For such a list, also nothing for its items (#118).
- Each kept event has only the snapshot keys of its type (`SNAPSHOT_KEYS` in `types.ts`, #118). `summaryInput` uses the same keys. Thus an "added" never has the old name, the from list, or the fields of a later rename or move.

**Pairs that cancel out (#133).** Each pair below gives no push, in each order where both orders are possible, also mixed with other events. A burst of only such pairs sends nothing, and makes no Claude call.
- Check / uncheck an item (app, MCP `check_items` / `uncheck_items`).
- Out of stock / in stock (app item menu, MCP `update_item` with `out_of_stock`).
- Add / delete an item, and the Undo of a copy (a delete of the new item).
- Delete an item / Undo (restore).
- Delete a list / Undo (restore). Create / delete a list.
- Rename a list and back. Move an item and back (also the Undo of a move).
- Edit an item and back: name, quantity, notes, or URL (app edit dialog, MCP `update_item`).
- Check all / Undo (an uncheck of each item). Uncheck all / Undo (a check of each item). Delete checked / Undo (a restore of each item). Check all / uncheck all, in each order. MCP `uncheck_all` and `clear_checked` are the same bulk ops.
- An item event and a bulk event of the same item, for example "check milk", then "uncheck all".
- Add a name that is checked on the list ("buy it again", app or MCP `add_items`) / check it.
- Delete an item / add a new item with the same name (exact), quantity, notes, and URL to the same list. The deleted item must not be checked or out of stock, its other changes in the burst must cancel out, and the new item must end unchecked and in stock.

How it works:
- **Edits:** the snapshot of an update has the old and new values of the fields that changed: `oldName` and `itemName` (there before #133), `oldQuantity` and `quantity`, `oldNotes` and `notes`, `oldUrl` and `url` (#140). A field ends at its first value if the old value of its first update is the new value of its last update. Older rows have no values: their fields count as changed.
- **Bulk ops:** each Undo sends one op for each item (`list-menu.tsx`). Thus a bulk op writes one row for each item, and collapse treats each row as a delete, an uncheck, or a check of that item (a `checkAll` row has `inStock` if it marked the item in stock). The rows that are left give one bulk event for each op type and list, with their count, at the place of the first row. Thus a partial cancel gives the correct count. An older bulk row (one row, `count`, no item) stays as it is.
- **Delete and add again:** an add and a delete have `quantity`, `notes`, and `url` (#140; an older row has no `url`: it counts as empty) in the snapshot, and a delete has `checked` and `outOfStock` when they are true. The new item has a new ID, thus collapse compares the two item groups after it collapses each one.
- The values (`quantity`, `notes`, `url`, `oldQuantity`, `oldNotes`, `oldUrl`, `checked`, `outOfStock`) are not in `SNAPSHOT_KEYS`, thus they do not go to Claude. Claude gets only `fields`: "changed the link for …". A name, a quantity, or notes that ends at its first value is not in `fields`, and an `oldName` that ends at the current name is dropped.
- **Not a cancel:** "Check all, then Undo" of an item that was out of stock: the check marked it in stock, and the Undo does not mark it out of stock again. The push says "marked in stock". The same for a delete of a checked item and an add again: the new item is unchecked.

**Each burst (#89):** `summarize.ts` calls Claude, also for one event, because Claude writes item names in lowercase, as in a sentence ("Sam added eggs to the “Whole Foods” list."). The fallback for one event is its template, with curly quotes, a/an, and "(via Claude)".
- `@anthropic-ai/sdk`, model `claude-sonnet-5-5`, with `output_config: { effort: "low", format: <zod { body: string }> }`.
- Server-side refusal fallbacks: beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`.
- 10s timeout and 1 retry. Check `stop_reason`.
- The prompt (`prompts.notificationSummary` in `src/prompts/`, see [Prompts](#prompts)) asks for one complete sentence of at most ~120 characters, as Apple's guidelines say: sentence case, proper punctuation, a period at the end, and no cut text. Item names in lowercase without quotes (brands and proper nouns keep their capitals), list names in curly quotes, changes to one list together, and up to three names of each kind, then "and N others". The owner's examples (#89): "Sam added eggs and checked off milk in the “Whole Foods” list.", "Sam added eggs to the “Whole Foods” list and milk to the “Smith’s” list.", "Sam added eggs, milk, bread, and 3 others to the “Whole Foods” list.". The prompt has an example for each kind of change.
- On any error or refusal, it falls back to the template for one event, or to "[Name] made N changes to …." for more.

**Built in #16** (`src/server/notify/`): `startNotifier()` runs from `src/instrumentation.ts` and ticks every 10 s. A tick does not throw: an error goes to the log (#100, also the summary worker). The model input has at most 50 changes; `more` gives the count of the others, by type. The update that marks the rows as sent goes in parts of 500 IDs. Rows are grouped by actor and `via`, so "(via Claude)" holds for the whole text. A group is sent after 60 s of quiet, or 3 minutes after its first row. The rows are marked as sent **before** the push: a crash can lose one push but never sends it twice, and rows that a restart leaves are sent at the next tick. For each recipient, rows on muted lists are dropped, then `collapse()` runs, so muted changes do not count. The query of the rows that are not sent has no `ORDER BY` (the sort is in JS): with `ORDER BY id`, SQLite scans the whole `activity` table, and not `activity_pending_idx` (#118). A unit test checks the query plan. The push title is the list name (one list) or "Shopping Lists", the URL is the list (or `/`), and the tag is the list ID (or `activity`). There are two more templates for a lone restore: “[Name] restored the “[list]” list” and “[Name] put “[item]” back on the “[list]” list”. a/an uses the first letter, and numbers that start with 8, or are 11 or 18, take "an".

**Built in #17** (`src/server/notify/summarize.ts`): `client.beta.messages.parse` with `betaZodOutputFormat({ body })`, `claude-sonnet-5-5` (`MODEL`, #106), `effort: "low"`, `max_tokens: 4000` (thinking is always on and counts), and server-side refusal fallbacks with `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`: Anthropic picks the fallback model for the refusal category). The client has a 10 s timeout and 1 retry. The input is JSON with names only (actor with "(via Claude)", and type, list, item, old name, from list, count, and, for an update, the fields that changed, for each change). Anything but `stop_reason: "end_turn"` with a parsed body, any error, or no `ANTHROPIC_API_KEY` gives the fixed fallback. The server makes the body one line and adds a period if there is none. It does not cut the body (#89): a body longer than 200 characters (`MAX_BODY`; the prompt asks for 120) gives the fallback, and the device cuts the text when necessary. `npm run try:summaries` prints seven sample bursts for a manual check.

**Sending:** `web-push` with VAPID keys. The payload carries a deep-link URL, and the notification `tag` is the list ID. Subscriptions that return 404 or 410 are deleted. A 429 with a `Retry-After` of 5 s or less gets one more try (#118). Each other failure adds one to `failure_count`, and sets `failing_since` (the first failure after the last success) and `last_failure_at`. A success clears them. A device whose failures go on for 7 days with no success (for example a 403 after a change of the VAPID keys) is turned off, and Settings shows "Not delivering" for it. To turn it on again, or to subscribe again, clears the failures.

**Settings:** "Enable notifications" must be tapped by the user, as iOS requires, and it only works in the installed PWA. Each device has its own on/off toggle, and each list has a mute toggle.

**Built in #15:**
- `/settings` (a link in the header; sign out moved there too). "This device": the Enable button, or why it can't (no server keys, Safari on iPhone/iPad outside the Home Screen app, blocked, unsupported). "Your devices": an on/off switch and Remove for each, and "Send a test notification". "Lists": a switch for each list (`list_mutes`). The list page has the same switches under the list name, without hint text: "Keep screen on" and "Notifications" (#82). They wrap into a column on a narrow screen. Both pages use `useMutedLists()` (`src/client/mutes.ts`) and `usePushDevice()` (`src/client/push-device.ts`, #98).
  - The list-page Notifications switch shows **this device** (#98): it is on only if this browser has a subscription with a device row that is on (`pushStatus()` is `on`) and the list is not muted. It is always in the page, thus it does not pop in (#136, owner's choice): it is disabled while the device and the mutes load, and stays disabled where push cannot work here (no server keys, iPhone or iPad Safari outside the Home Screen app, notifications blocked, an unsupported browser). The list page has no hint text; Settings tells why. The "Lists" switches in Settings also show with the lists, disabled until the mutes load. On, from Off, turns on push on this device in one tap (the permission prompt, the subscription, or a device that is off), then unmutes the list. Off mutes the list on all devices, and a toast tells so. `GET /api/push/subscriptions` also gives the VAPID public key, because the list page is a client shell.
  - A switch that fails (a device, Remove, a list mute) goes back, and a toast tells why (#104).
- API: `GET/POST /api/push/subscriptions`, `PATCH/DELETE /api/push/subscriptions/<id>`, `POST /api/push/test`, `GET/PUT /api/push/mutes`. The endpoint is unique: a browser that subscribes again replaces its row. An endpoint of a different user does not move to the caller: 409 (#100). The endpoint must be on a known push service (`PUSH_SERVICE_HOSTS` in `src/shared/push.ts`: FCM, Mozilla, Apple, Windows), because the server sends requests to it. The e2e tests use a loopback endpoint, which the server accepts only with the auth stub.
- JSON routes (#100): `readJson(request, schema, { maxBytes })` (`src/server/json.ts`) requires `application/json` (415), limits the size (413, 16 KB by default, 1 MB for a sync push; it stops reading at the limit, also for a chunked body with no `content-length`), and parses with a `z.strictObject` schema (400 for unknown keys). The push, presence, and sync routes use it. `POST /api/push/test` takes `{}`.
- `src/server/push.ts`: `sendToUser(userId, payload)` sends to the enabled devices with a 24 h TTL and a 10 s timeout (#100: a push service that does not answer must not stop the notifier), deletes a subscription on 404 or 410, sets `last_success_at`, and counts the other failures (see Sending). Keys come from `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. The subject is `VAPID_SUBJECT`, or the app origin, so no email is needed. Without keys, nothing is sent.
- The service worker shows the payload (`PushPayload`: title, body, url, tag). A tap focuses a window of the app on that URL, or opens one. Only same-origin URLs are used.

## List summaries
Code in `src/server/summary/`. The lists page shows one line under each list name, so you can see at a glance what to get:
- No unchecked items: "Nothing to get".
- 1 unchecked item: its name, as the user wrote it. The client makes this line at once, with no API call.
- 2 or more: the summary from Claude in `lists.summary`, for example "Milk and eggs" or "Milk, eggs, produce, and snacks for the party". Claude also corrects the capitals. If there is no summary yet, the count ("3 items").

The list page shows no count.

**Worker** (`worker.ts`): an in-process interval (10 s), started at boot only with `ANTHROPIC_API_KEY`. For each list with 2 or more unchecked items, it makes `summaryKey()`: a hash of the names and quantities, in any order (the notes are not in the summary). If the key is not the same as `lists.summary_key`, it waits until the key stays the same for 60 s, or 3 minutes after the first change at most, then asks Claude. The wait is in memory: a restart starts it again. After a failure, it tries the same items again after 10 minutes. During the wait, the page shows the old summary.

**Write:** `setListSummary()` in `src/server/ops.ts` sets `summary` and `summary_key` and gives the list a new seq and a poke, thus the clients pull it like other list changes. It does not change the clocks, `updated_by/at/via`, or `activity`: a summary is not a change by a person, and sends no notification.

**Claude** (`summarize.ts`): the same request as the notification summary (`claude-sonnet-5-5`, `effort: "low"`, structured output `{ summary }`, server-side refusal fallbacks, 10 s timeout, 1 retry). The input is the list name and at most 200 items, with names and quantities only. The prompt (`prompts.listSummary`) asks for at most 60 characters; the server cuts at 90. Any error or refusal gives no summary. `npm run try:summaries` prints two sample lists.

## Prompts

All the prompts for Claude are in one module, `src/prompts/index.ts` (#84), exported as `prompts`. It is `server-only`.

- `notificationSummary`: the system prompt for the push text (`src/server/notify/summarize.ts`), and the length that it asks for.
- `listSummary`: the system prompt for the list summary (`src/server/summary/summarize.ts`), and the length that it asks for.
- `mcpInstructions`: the MCP server instructions (`src/server/mcp/server.ts`).

The prompt text uses the length value, thus you change it in one place. A unit test makes sure that the server limits (`MAX_BODY`, `MAX_SUMMARY`) stay longer than the length that the prompt asks for. The model settings (model, effort, `max_tokens`) and the `summaryInput` functions stay in the modules that send the requests. The MCP tool and field descriptions stay in `TOOLS`, each next to its schema. To try a change, run `npm run try:summaries`.

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
- A request without the required `_meta` fields gets 400 with -32602. An unknown method gets 404 with -32601.
- Validate `Origin` first: 403 if it is present and its hostname is not the app hostname, `claude.ai`, or `claude.com`. The check compares only the hostname, not the scheme or the port (`originValidationResponse` of the SDK). Then the token (401/403), then the protocol checks.
- Return JSON responses. Only stream SSE if something needs it, and then send `X-Accel-Buffering: no` and keep-alives. Closing the stream counts as cancellation.
- Not used: sampling, roots and logging (all deprecated); `subscriptions/listen` and the tasks extension (not needed); elicitation (Duet's own approval step covers destructive actions).

### Implementation
**Decided in #19:** the official SDK, `@modelcontextprotocol/server` v2. It serves 2026-07-28 statelessly and does the protocol checks above: `server/discover`, the header and version errors, `resultType`, and the cache hints.
- `createMcpHandler` builds a new `McpServer` for each request, for the caller of that request. With its default `legacy: "stateless"`, a 2025-era client that sends `initialize` gets the same tools from the same factory, with no session.
- `src/server/mcp/server.ts` has the factory and the route: the Origin check, then `withMcpAuth` (`src/server/mcp/auth.ts`, #18), then the SDK handler with the caller as `AuthInfo`. The handler accepts a body of at most 1 MiB (`MAX_MCP_BODY_BYTES`, #116; the SDK default is 4 MiB), else 413.
- `src/server/mcp/tools.ts` has the tools: one list (`TOOLS`) with the schemas, the annotations, the scope, and the code of each tool.

### Authorization
OAuth 2.1. The app is both the authorization server (AS) and the resource server.

**Library (decided in #18):** Better Auth. `@better-auth/mcp` (`mcp()`, the OAuth provider set up for MCP), `@better-auth/cimd` with the `mcp-2026-07-28` profile, and the JWT plugin. It passes the whole checklist below, thus no `oidc-provider` and no AS of our own. Config: `src/lib/auth.ts`, `src/lib/oauth.ts`. The endpoints are under `/api/auth/oauth2/*` (authorize, token, register, revoke). The tables are in `src/db/schema.ts` (`jwks`, `oauth_*`).

**Discovery:**
- The issuer is the app origin (`jwt.issuer`), thus the AS metadata (RFC 8414) is at `/.well-known/oauth-authorization-server`. The `issuer` must match exactly. It advertises:
  - `client_id_metadata_document_supported: true`;
  - `registration_endpoint` (DCR is deprecated, but older clients still use it);
  - `authorization_response_iss_parameter_supported: true`;
  - PKCE S256 only;
  - `scopes_supported: ["lists:read", "lists:write", "offline_access"]`;
  - the grants `authorization_code` and `refresh_token` only.
- Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, with `authorization_servers`. Its `scopes_supported` has no `offline_access`: the spec says refresh tokens are not a resource need.
- A 401 sends `WWW-Authenticate: Bearer resource_metadata="…", scope="lists:read lists:write"`. A missing scope gets 403 `insufficient_scope` naming every scope the request needs.

**Client registration:**
- Client ID Metadata Documents first. The plugin fetches the https `client_id` URL, checks that `client_id` matches exactly, uses its `redirect_uris`, and caches it. SSRF guard: https only, a public host (DNS resolved one time, the connection pinned to the checked address), no redirects, a 5-second timeout, a 5 KB limit, and fetch rate limits.
- DCR as a fallback. Anyone can register (5 a minute for each IP), but a client gets nothing until an allowlisted user approves it. A hook refuses a registration without `application_type` (the provider would use "web").
- Clients come only from CIMD and DCR. `/oauth2/create-client` and the other client endpoints are in `DISABLED_PATHS` (#116). `clientPrivileges` allows only "create", because a DCR request with a session cookie checks it. `resourcePrivileges` allows nothing.

**Tokens:**
- `iss` (RFC 9207) goes in every authorization response, errors included.
- An authorization request must have `resource` (RFC 8707); a hook refuses it without. The token request can omit it: the code keeps the resource. Each access token's `aud` is the canonical `https://<host>/mcp`, and a client is linked only to that resource.
- Google tokens never reach the MCP endpoint.
- Access tokens are JWTs (`typ: at+jwt`) for 15 minutes.
- Refresh tokens last 90 days from the last refresh and are issued only with `offline_access`, so Duet keeps working in the background. Each refresh rotates the token. A retry in 30 seconds gets the same answer (the `mcp()` default, for lost responses); a later reuse is a replay and revokes all the refresh tokens of the grant.
- `/mcp` (`src/server/mcp/auth.ts`) checks the signature, `iss`, `aud`, `exp`, `azp`, `typ` and the scopes. A JWT stays valid until it expires, thus it also checks the database at each request: the user is still in `ALLOWED_EMAILS`, and the grant (consent) of the user for the client exists. A revoke deletes the grant, thus it stops a token at once. The token `iat` must be at or after the time of the last consent (#116): thus a token from before a disconnect does not work again when the user connects the same client again. The caller gets only the scopes that are in the token and in the consent.

**Consent:** Google sign-in (allowlist), then `/oauth/consent`. The client name is the client's own claim, thus the page also shows the hosts the user can check: the client ID host (CIMD) and the redirect host, with a warning for a localhost redirect. A DCR client has no client ID host: "App from" shows a "Not verified" badge (#116). The token belongs to that user, and its ops are recorded with `via: "mcp"`.

**Connected apps:** Settings lists the approved clients. "Disconnect" deletes the grant, revokes the refresh tokens, and deletes the opaque access tokens (`src/server/connected-apps.ts`). Settings also shows the connector URL (`mcpResource()`, `<origin>/mcp`) with a `<wa-copy-button>` (#73). Its tooltip is off, because the tooltip replaces the accessible name of the button; a toast tells the result.

### Tools
- `tools/list` returns tools in a fixed order, with `ttlMs` and `cacheScope: "private"`.
- Every tool has `title`, `description`, `inputSchema` and `outputSchema`. Results return matching `structuredContent`, plus the same JSON in a text block.
- Business errors (unknown list, deleted item) return `isError: true`, with a message that helps the model recover: an unknown list names the lists. Arguments that fail the input schema also return `isError: true` (the SDK, per the spec), not -32602.
- Each tool takes a list (`list`, `to_list`) as a `list_id` or a case-insensitive name, and an item (`item`, `items`) as an `item_id` or a case-insensitive name on that list. Two lists or items with the same name are an error that gives their IDs. If any item is unknown, the tool changes nothing. A list reference has at most 100 characters and an item reference at most 200 (the name limits, #116): a longer one is a schema error, and the error text does not quote it.
- Write tools accept an optional `idempotency_key`. The op IDs (and the IDs of new lists and items) come from a hash of the user, the tool, the key, a hash of the arguments (canonical JSON, #101), and the position. Thus a retry with the same key and arguments gets "duplicate" results and changes nothing, and the same key with different arguments makes the change.
- An unexpected error gives a general `isError` text to the client; the detail goes to the server log (#101).
- Every write calls `applyOps` with `via: "mcp"`. Reads use `src/server/queries.ts`.
- Scopes: read tools need `lists:read`, write tools `lists:write`. A missing scope gets 403 `insufficient_scope` before the tool runs (the SDK `scopeChallenge`). `tools/list` shows all the tools.
- Each item output has `url` (#140): an http or https URL, or empty. `add_items` and `update_item` take `url`; an empty string removes it, and any other scheme is a schema error.
- Each item output has `out_of_stock` (#131). `update_item` takes `out_of_stock` (a boolean) with or without the other fields: it sends a `markOutOfStock` or `markInStock` op after the `updateItem`. Its description says that a mark also unchecks the item; `check_items` and `move_item` say that they mark it in stock.
- `create_list` refuses a name that a live list has, because names are references. `add_items` does not change the quantity or the notes of an item that is already on the list: use `update_item`.
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
| `update_item` | idempotent | `out_of_stock` marks the item out of stock or in stock (#131) |
| `check_items`, `uncheck_items` | idempotent, non-destructive | |
| `delete_items` | **destructive**, idempotent | |
| `move_item` | idempotent | |
| `clear_checked` | **destructive** | |
| `uncheck_all` | idempotent | |

**Server instructions** (`prompts.mcpInstructions`, in `server/discover`) explain the data model, sorting, dedupe (adding an existing item unchecks it), "via Claude" attribution, and that destructive tools should be confirmed with the user.

## UI
Mobile-first. Routes under `src/app/(app)/`.

- **Copy (#66):** all the text that the app shows is in one typed dictionary, `src/copy/en.ts`, exported as `copy` from `src/copy`. This includes headings, labels, `aria-label` and icon labels, sr-only text, toasts, dialogs, relative times and history lines, the Web Awesome "Fewer"/"More" overrides, push text, page titles, and the manifest. List and item names are data, not copy. The prompts for Claude are model input, not copy: they are in `src/prompts/` (see [Prompts](#prompts)).
  - One module for server and client components, the service worker, and the e2e tests: a static import, so no request-time work under Cache Components. This is the dictionary approach of the Next.js i18n guide, without `server-only` and without a `[lang]` segment.
  - Text with values is a function (`copy.lists.deleted(name)`). Counts use `pluralFor(locale)` (`src/copy/plural.ts`, `Intl.PluralRules`), not `n === 1`. A missing key or a wrong value fails `npm run typecheck`.
  - One locale (`en`). To add one: a new file of type `Dictionary`, added to `dictionaries` in `src/copy/index.ts`. Components do not change. `locale` is also the `<html lang>` and the `Intl` locale.
  - ESLint (`eslint.config.mjs`) refuses JSX text and literal `label`, `placeholder`, `hint`, `title`, `alt`, `aria-label`, and `confirmLabel` props in `src/app` and `src/client`.
  - The e2e tests import `copy`, so a copy change does not break them.

- **`/sign-in`:** one "Sign in with Google" button. `src/proxy.ts` (Next 16 renamed middleware to proxy) sends signed-out users here, and allowlist rejections show a short error.
- **`/`:** the lists. Create, rename, delete with undo, and presence dots. On desktop it's a two-pane layout: a list sidebar beside the open list.
- **Shell (#8):** `src/app/(app)/layout.tsx`. The header (app name, sync status, a Settings link, avatar) is sticky, and every edge has the safe-area insets (`viewportFit: "cover"`). At `lg` and wider, the lists are a sidebar; `/` then shows a prompt to pick a list. Each list row has a "More" button with Rename (inline form) and Delete (a `<dialog>` to confirm). Components are in `src/app/(app)/_components/`.
- **`/lists/[id]`:**
  - an add bar fixed to the bottom, with autocomplete and dedupe;
  - large tap targets to check items;
  - delete from the item menu, with an undo toast;
  - an item sheet: name, quantity stepper (at the end of an edit, it shows the clamped value: `clampQuantity()` in `src/shared/quantity.ts`, #104), URL (#140), notes, "Added by X · time" and "Updated by Y (via Claude) · time";
  - move to another list, and a "Clear checked / Uncheck all" menu;
  - built in #13: a "List actions" menu beside the `h1` (rename, uncheck all, clear checked items with a confirmation, delete list) and "Move to" in the item sheet (#131 moved it to the item menu). Each delete, move, and bulk action shows a toast with Undo for 5 s (`src/client/toasts.ts`, `_components/toaster.tsx`). Undo sends `restoreItem`, `restoreList`, `moveItem` back, or one `restoreItem`/`check` for each item that the bulk op changed. The toaster also shows each change that the server refused.
  - an "editing…" badge on items the other person is editing.
  - Item menu (#131, `item-row.tsx`): a "…" `wa-dropdown` on each row (label "More for <name>") with Edit (pencil), Visit page (arrow-up-right-from-square, only for an item with a URL, #140), Move (swap), Copy (copy), Out of stock (cart-circle-xmark) or In stock (cart-circle-check), a divider, and Delete. A checked item has no stock item: it cannot be out of stock. Move and Copy are disabled when there is no other list. The item sheet has no Move and no Delete now: only the name, the quantity, the notes, and the history. Delete shows a toast with Undo, as before.
  - Move and Copy open the same dialog (`list-picker.tsx`): a `wa-select` (label "List") of the other lists, by name, and a primary Move or Copy button (#134). The select has the focus when the dialog opens; its field is read-only, thus the on-screen keyboard does not open. The button is disabled until the user selects a list, and each open starts with no list. With many lists, the dialog stays short: the listbox scrolls, in the top layer. Move or Copy acts and closes the dialog; Cancel, Escape, and a tap outside close it with no change. (#131 had one button for each list: with many lists, the dialog got taller than a phone screen.) Move sends `moveItem` and shows a toast with Undo. Copy (`copyPlan()` in `src/client/copy-item.ts`) uses the dedupe rules of the add bar on the target list: no match makes an `addItem` with the same name, quantity, and notes (Undo deletes the copy); a checked match is unchecked and gets the quantity and the notes that are not the defaults (#120); an unchecked match changes nothing, and a toast tells so.
  - URL (#140): a link to a web page for the item, such as a product page. The sheet field is above the notes. It is a text field with the URL keyboard (`inputmode="url"`), not `type="url"`: the browser refuses a URL with no scheme. `normalizeUrl()` (`src/shared/url.ts`) trims the text and adds `https://` when there is no scheme ("store.com/milk"). Other text makes the field invalid (`setCustomValidity`), thus the form does not submit. The row shows a `link` icon and the host without "www." below the notes, in `ink-muted`, with "link to" for a screen reader. It is not a link: the row is one checkbox button, and a link in a button is not valid. Visit page opens the URL in a new tab (`window.open` with `noopener,noreferrer`, in the select event of the tap). The row checks `isWebUrl()` again before it opens one. A copy (Move and Copy dialog) keeps the URL; a checked match gets it if it is not empty and different. The add bar has no URL field. A row from an older server has no `url`: the client reads it as empty.
  - Out of stock adds a `warning` badge with the cart icon below the notes, and shows a toast for 10 s: "“Milk” is out of stock. Get it at another store?" with Move and Copy. Those open the dialog. To decline, the user does nothing, or closes the toast. A toast item can have more than one action (`actions` in `src/client/toasts.ts`). No toast for In stock. The Undo of a move does not mark the item out of stock again (as it does not check it again, #112).
  - "Older items" (#112): a `<section>` with an `<h2>` at the bottom of the list page. It has the checked items that the server deletes in the next 15 local calendar days, with the delete that comes soonest last (`splitOlder()` in `src/client/queries.ts`). It is not present when it is empty. Each row has a `<wa-badge>`: "Expires in N days", "Expires tomorrow", or "Expires today", `brand`, then `warning` at 7 days or less, then `danger` at 1 day or less. Days are local calendar days: a delete on Wednesday at 11 pm is "tomorrow" all of Tuesday. `useNow()` (`src/client/use-now.ts`) gives the time each minute and when the page comes to the front; it is null before mount. A checked row shows its text in `ink-muted`, not with opacity, and only the check circle fades: opacity on the text or on the row fails the contrast scan.
  - Built in #9 (`src/app/(app)/lists/[id]/`): each row is one large `role="checkbox"` button with an Edit button beside it (#131 replaced it with the item menu). The add bar is sticky at the bottom, with quantity and notes behind a "Quantity and notes" icon button; they open below the name (#56). The sheet is a `<dialog>`: a bottom sheet on a phone, centered at `lg`. It takes focus itself, so the keyboard does not open. Swipe-to-delete is not built. Forms clear before the write, so fast entry keeps each item.
- **Header:** an offline indicator with the number of pending changes.
- **Keep screen on (#20):** a switch in Settings (owner's choice: not in the header), and on the list page (#82). It uses the Screen Wake Lock API, re-acquires the lock on `visibilitychange`, is remembered per device. The switch is always in the page (#136): disabled until the setting is known, and where the API isn't supported (in Settings, the hint then tells so). It reads the setting with `useSyncExternalStore`, thus the list page knows it at the first render. `WakeLockKeeper` in the `(app)` layout holds the lock on every page while the setting is on (`_components/keep-screen-on.tsx`, logic in `src/client/wake-lock.ts`). A refused request shows a toast, one time in each session (#104). There is one request at a time: an acquire while a request is open waits for it (#120). `dispose()` sets the state to off, thus a lock that arrives after it is released.
- **PWA:** `manifest.webmanifest` (standalone, icons, theme color), apple-touch-icon, safe-area insets.
- **Service worker (#10):** Serwist. `src/sw/sw.ts` (its own `tsconfig.json` with the `webworker` lib). `scripts/build-sw.mjs` runs after `next build`: it calls the `@serwist/turbopack` route handler one time and writes `public/sw.js`. Thus the server and the Docker image need no esbuild and no source at runtime (a route handler is dynamic under Cache Components, and would bundle at the first request). `/sw.js` has `Cache-Control: no-cache` and scope `/`.
  - Caching: the precache has the build assets and `/~offline`. Pages and RSC payloads have their own rules before `defaultCache` (#103): network first with a 3 s network timeout, then the cache, for 30 days from the last use (`maxAgeFrom: "last-used"`, caches `pages` and `pages-rsc`). The `defaultCache` rules kept a page for 24 h from the fetch, thus a cold start offline one day after the last use showed `/~offline`. `/api/*` never goes through the worker: a first `fetch` listener stops the Serwist listeners, so sync sees the server and SSE stays native.
  - Only the app pages are cached (#117, `src/sw/page-cache.ts`): `/`, `/settings`, and `/lists/<id>` (also the list shell). The RSC rule takes only navigations: Next.js 16 sends `Next-Router-Prefetch` with 1, 2, or 3 on a prefetch. Each other same-origin page (sign-in, OAuth consent with its signed query, `/.well-known/*`) and each prefetch is network only. Without that rule, the `others` rule of `defaultCache` kept them.
  - A redirect never replaces a cached page (#117): the page rules keep a response only if it is `ok`, `type` is `basic`, it is not `redirected`, and its body has no `NEXT_REDIRECT`. The 307 of `src/proxy.ts` (no cookie) is an `opaqueredirect` with status 0, which the default plugin of `NetworkFirst` kept. A cookie with no session gives 200: `requireUser()` redirects in the stream.
  - `/` is not precached: without a session it redirects, and that can fail the install. Instead `src/app/service-worker.tsx` asks the worker to cache each page that the app shows (`CACHE_URLS`), also the first one.
  - List shell (#103): the app also caches `/lists/shell` (`LIST_SHELL_PATH` in `src/shared/offline.ts`). Offline, a list page that is not in the cache gets the shell. The list view reads the list ID from `usePathname()` (it follows the URL of the browser), not from `useParams()` (the params of the served HTML). Thus a list that this device did not open online (for example, a new list of the other person) opens offline. Another page that is not in the cache gets `/~offline`. The plugin of the page rule gives both: Serwist does not add its fallback to a handler that has a `handlerDidError` plugin.
  - Update: `skipWaiting` and `clientsClaim`. When a new worker takes control, a "new version" toast offers a reload.
  - Old pages after a deploy (#117): a new worker removes the old `/_next/static` files from the precache, and the server does not have them. A page of the old version can then load them only from the HTTP cache of the browser. If they are not there (WebKit removes it more often), the page does not start offline, or when the network is slower than the 3 s timeout. Thus at `activate` the worker fetches each page in `pages` again (`redirect: "manual"`, 4 at a time, 15 s for all), keeps the good copies, and deletes the others. It deletes `pages-rsc`, and the `pages-rsc-prefetch` and `others` caches of older versions. A list page that is gone then gets the list shell offline. The fetches block the fetch events of the pages until the activate is done: 15 s at most.
  - Registration is production only. The `(app)` layout mounts it.
- **Dark mode (#22, #51: now through the Web Awesome tokens):** follows the system setting; there's no toggle. The server-rendered `<head>` has `<meta name="color-scheme" content="light dark">`, and `:root` has `color-scheme: light dark`, so Safari's [Adaptive Dark Mode](https://webkit.org/blog/18541/introducing-adaptive-dark-mode/) leaves the app alone. Colors are CSS variables with light and dark values under `prefers-color-scheme`, mapped to Tailwind tokens with `@theme inline` in `src/app/globals.css`: `canvas`, `surface`, `ink`, `ink-muted`, `line`, `accent`, `accent-ink`, `accent-soft`, `danger`. Light is pale leaf-gray with market green; dark is a grocer's chalkboard with leaf green. Every text pair is at least 5.9:1. `e2e/theme.spec.ts` runs axe in both schemes. `theme-color` is set for each scheme. Every UI change must work in both.
- Use the frontend-design skill when building the UI.
- **Web Awesome Pro (#51):** the components are `<wa-*>` tags, loaded one by one in `src/app/web-awesome.ts` (a client module that the root layout mounts). Server components render the tags, and the browser upgrades them.
  - Theme: `scripts/build-wa-dark.mjs` (in `npm run assets`, before build, dev, and typecheck) writes `src/app/generated/wa-theme.css` (the default theme with its nested `@import url()` inlined: Tailwind does not follow them) and `wa-dark.css` (the theme's `.wa-dark` tokens under `@media (prefers-color-scheme: dark)`). Our colors are `--wa-*` overrides in the `wa-theme-overrides` layer. Tailwind color tokens point to the `--wa-*` tokens, and `--spacing` is inline: dialogs and drawers set their own `--spacing`.
  - Base layer (#56): `scripts/build-base-css.mjs` (also in `npm run assets`) writes `src/app/generated/base.css`. `globals.css` imports Tailwind in parts (theme, this file, utilities), not `tailwindcss`. The stock preflight resets margin, padding, and border on `*`. A page rule wins over the `:host` rule of a component, thus it removed the padding and the borders of dropdown items, callouts, badges, options, and the toast stack. The generated preflight skips every Web Awesome tag (from `custom-elements.json`). Our focus ring is for native controls only; components draw their own.
  - No FOUCE: the same file makes each `wa-*` tag `visibility: hidden` until it is defined, for all the tags of the package. Not `.wa-cloak`: it hides the whole page while any custom element (also the Next.js route announcer) is undefined, so each client navigation blanked the page.
  - Toasts (#56): `toast.create()` with plain text (no `allowHtml`: names come from users), and the action button on its own line below. Each item closes itself after 5 s with the countdown ring, and waits while the pointer is on it. The "new version" prompt is a toast with Reload that stays until closed.
  - Fields: `--wa-form-control-background-color` is the raised surface, like the cards. The neutral fills and control borders are green-gray. The add bar's native combobox input uses the `--wa-form-control-*` tokens to look like a large `wa-input`.
  - Icons: `scripts/build-icons.mjs` writes the icons in `src/app/icons.json` from the Pro regular and free brands packages to `public/icons/` (gitignored). `setIconPath("/icons")` and classic regular are the defaults. The service worker precaches `public/`.
  - Choices: the item sheet is a bottom `wa-drawer` below `lg` and a `wa-dialog` at `lg`. The add bar keeps its own combobox: `aria-activedescendant` cannot point into a shadow root, and our ranking and tap-to-add do not fit `wa-combobox`. The item row stays one native button. In-app links stay Next.js `<Link>` (client navigation); `wa-button href` is for full page loads.

## Infra
- **Fly:** `fly.toml` with one shared-cpu machine, always on, and a volume at `/data`. The app name is not in `fly.toml` (the repo is public), so deploys use `-a <app>`. The entrypoint (`scripts/docker-entrypoint.sh`) runs as root only to give `/data` to the `node` user. It gives the database files (also `-wal` and `-shm`) to the `node` user. It runs `litestream restore -if-db-not-exists`, then `litestream replicate -exec "node server.js"`. If the restore cannot reach R2, or finds no replica, the machine stops, so a new volume never starts an empty database (#102). `ALLOW_EMPTY_REPLICA=1` adds `-if-replica-exists`, only for the first deploy (`docs/ops.md`). `litestream.yml` points at an R2 bucket.
- **Migrations:** the server applies them at start, in `src/instrumentation.ts`, before the first request. Litestream accepts a database file that does not exist yet. The migrations use a connection with `foreign_keys = OFF`: drizzle-kit rebuilds a table in the transaction of the migration, where `PRAGMA foreign_keys=OFF` has no effect, and with the keys on, the drop of the old table deletes the child rows through `ON DELETE cascade`. After a boot that applies a migration, `PRAGMA foreign_key_check` must give no rows, or the server does not start (#102). A throw in `register()` does not stop the Next.js server: it logs the error and serves requests. Thus `register()` calls `process.exit(1)` when the migrations fail (#119), and Litestream (`-exec`) stops too. The connection uses `journal_mode = WAL` and `synchronous = NORMAL` (the Litestream setting for WAL, #119). CI fails if `drizzle-kit generate` makes a new migration (a schema change with no migration).
- **Health (#102):** `GET /api/health/live` (no auth) runs `select 1`; the Fly service check uses it. `GET /api/health` also checks the replication: it reads the Litestream metrics on localhost (`LITESTREAM_METRICS_URL`, set in the image) and gives 503 if a change was not uploaded within 5 minutes, or if it cannot read the metrics. Litestream 0.5 has no metric for the time of the last upload, thus the server compares `litestream_txid` and the PUT count of `litestream_replica_operation_total` at each check. The top-level Fly check `replication` and the CI deploy check use it. It is not the service check, because a failed service check stops the traffic to the one machine. Limits (#119):
  - The first sample after a boot is always ok, and a problem shows only after 5 minutes. Thus the CI deploy check shows only that the server and the metrics answer. The Fly check (each 60 s) finds a replication problem later.
  - Litestream 0.5.18 counts a PUT only after the upload succeeded (`WriteLTXFile` in `s3/replica_client.go`), and it has no error metric for a failed PUT. If a write and a good upload of an earlier change come in the same check window and then R2 stops, the last write is not uploaded and the check stays ok until the next write. The next write gives no PUT, thus the check then shows the problem after 5 minutes. Litestream tries the upload again.
- **Headers (#102):** `next.config.ts` sets for all routes `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS (no `includeSubDomains`: the zone is shared), and a small `Permissions-Policy`, with no `X-Powered-By`. There is no full CSP yet.
- **Client IP (#102):** Better Auth reads `X-Forwarded-For` from the right and skips the Cloudflare ranges (`src/lib/client-ip.ts`). Cloudflare sets the client IP, and Fly adds the Cloudflare IP, thus the rate limits are per client. Without this, Better Auth found no IP and used one shared bucket.
- **Secrets:** Google client ID/secret, `BETTER_AUTH_SECRET`, `ALLOWED_EMAILS`, VAPID keys, `ANTHROPIC_API_KEY`, R2 credentials. They live in Fly secrets and `.env.local`, never in the repo or issues: both are public.
- **Cloudflare:** a proxied CNAME to Fly. The Fly certificate uses the ACME DNS challenge and the `_fly-ownership` TXT record, because the proxy hides Fly. The zone is shared with other hosts, so a Configuration Rule sets SSL Full (strict) for this host only, and a Cache Rule for this host bypasses the cache for `/api/*` and `/sw.js`. The service worker is served with `Cache-Control: no-cache`. Use the `cf` CLI with `--dry-run` first.
- **CI/CD (#24):** GitHub Actions runs the checks (format, lint, typecheck, unit and e2e tests, `npm audit`, unapproved install scripts) on each PR and on `main`. The e2e tests run in one job for each browser (WebKit on an iPhone, Chromium on a desktop), at the same time as the other checks (#85). The report uploads when a test fails or is flaky. A green push to `main` runs `flyctl deploy --remote-only`, then the health check. `[skip deploy]` or `[no deploy]` in the commit message skips the deploy. The flyctl version is fixed in the workflow. Results go to Slack through an incoming webhook. Each third-party action is pinned to a commit SHA, `FLY_API_TOKEN` goes only to the deploy step, and event values reach scripts only through `env:`. `PRODUCTION_URL` is a secret, because the repo is public. Migrations run at boot, not in a Fly `release_command`, because that machine has no volume.
- **Dependabot (#25):** weekly updates for npm, GitHub Actions (including the composite actions), and the Docker base images, with a short cooldown. Minor and patch updates are grouped. The `allowScripts` entry of `better-sqlite3` has an exact version (the dependency is a `^` range), so a bump of it needs a new approval. `esbuild`, `fsevents`, and `@swc/core` are denied: they work without their install scripts.

- **Backups (#20):** the restore drill and the steps to restore the live app are in `docs/ops.md`. The drill runs `scripts/restore-drill.sh` (in the image) on a scratch machine: it restores to `/tmp`, checks the database, and only reads from R2.

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

**End-to-end tests (Playwright):** each test runs on the `mobile` (WebKit) and `desktop` (Chromium) projects. A test with the tag `@once` runs on desktop only, because the browser does not change its result (#85). When the stub is on, the Better Auth rate limit is off: all the e2e requests come from one IP.
- two browser contexts as two users: realtime updates within about 1s, and presence badges;
- `context.setOffline(true)`: make edits, go back online, confirm they reconcile, with conflicting edits on both sides;
- the undo toast;
- a non-allowlisted account being rejected (a test auth stub stands in for Google). The stub (`src/lib/auth-stub.ts`) runs through the same Better Auth path as the Google callback. The standalone server always sets `NODE_ENV=production`, so the stub needs `AUTH_STUB=1`, an http loopback `BETTER_AUTH_URL`, and no `FLY_APP_NAME`.

**MCP contract tests (vitest) against `/mcp`** (`src/server/mcp/auth.test.ts`, `src/server/mcp/server.test.ts`):
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

**Accessibility (#20):** `e2e/a11y.spec.ts` runs axe (WCAG 2.2 A and AA) on the main screens in light and dark, on a phone and a desktop: no serious or critical issues. It waits for the Web Awesome animations, also in shadow roots, because colors in a fade are not the real colors. It also tests the item sheet with reduced motion, and the "Keep screen on" toggle with a fake Wake Lock API.

**On a real device (installed iPhone PWA):** Google sign-in, push permission and delivery, deep links from notifications, the wake lock keeping the screen on, airplane-mode shopping and then sync.

**Ops:** run `fly deploy`, restore Litestream from R2 into a scratch machine, and confirm SSE stays open through Cloudflare past 100s.
