# Shopping Lists

A private shopping list app for two people. It is a mobile-first web app that you install on the iPhone Home Screen and use in the store, with a two-pane layout for planning on a laptop. It works offline, shows changes from the other person in real time, sends push notifications, and lets Claude read and edit the lists through an MCP server.

Only the Google accounts on an allowlist can sign in.

## Features

**Lists and items**

- Make, rename, and delete lists.
- Add items with a quantity and notes. The add bar suggests items that you added before, and it does not add the same item two times.
- Tap an item to check it off. Check all, uncheck all, or delete the checked items from the list menu.
- Move an item to a different list.
- Each item shows who added it, who changed it last, and when.
- Undo each delete, move, and bulk action from the toast.

**Offline and sync**

- All changes go to the device first, so the app works with no connection. The changes sync when the connection comes back.
- The header shows when the app is offline and how many changes it must sync.
- When two people change the same item, each field keeps the latest change. For example, one person can check an item while the other changes its notes.

**Real time**

- Changes from the other person show in a second or two.
- A dot shows which list the other person has open, and an "editing…" badge shows which item they are editing.

**Notifications**

- Push notifications when the other person changes a list, on the installed iPhone app and on desktop browsers.
- The app waits until the other person stops for a minute, then sends one notification. One change gets a fixed sentence, such as "Sam added “Milk” to the “Costco” list". More than one change gets a one-line summary that Claude writes.
- Turn notifications on or off for each device, and mute each list.

**Claude**

- A remote MCP server at `/mcp`. Claude (claude.ai, Claude Desktop, Claude Code, and Duet) can read the lists, add and check items, and do all other list actions.
- Changes from Claude show as "Sam (via Claude)".
- Claude connects with OAuth through the same Google sign-in. Settings shows the connector URL and the connected apps, and you can disconnect each app.

**Other**

- Light and dark mode, from the system setting.
- "Keep screen on", so the phone does not lock while you shop.
- Continuous backups of the database to Cloudflare R2, with Litestream.

## How it works

One Next.js server on one Fly.io machine, with SQLite on a volume. The browser keeps a copy of the data in IndexedDB and syncs it with the server. Server-sent events tell the browser when to sync. The app, the sync, and the MCP server all write through one function, `applyOps` in `src/server/ops.ts`, thus attribution, realtime updates, and notifications are the same for each source.

[`docs/PLAN.md`](docs/PLAN.md) has the architecture and the decisions. [`docs/ops.md`](docs/ops.md) has the backup and restore steps.

**Stack:** Next.js 16 (App Router), TypeScript, Tailwind, Web Awesome Pro, Font Awesome Pro, SQLite with Drizzle, Dexie, Serwist, Better Auth, the MCP TypeScript SDK, and the Anthropic SDK.

## Setup

### What you need

- Node 24 or later, and npm.
- Tokens for the Web Awesome Pro and Font Awesome Pro npm registries. The UI uses Pro packages, so `npm install` fails without them.
- A Google OAuth client (Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type "Web application"). Add this redirect URI: `<your app URL>/api/auth/callback/google`, for example `http://localhost:3000/api/auth/callback/google`.
- Optional: an Anthropic API key for the notification summaries. Without one, the app uses a fixed sentence ("Sam made 3 changes to the “Costco” list").

### Install

```sh
export WEBAWESOME_NPM_TOKEN=...
export FONTAWESOME_NPM_AUTH_TOKEN=...
npm install
```

`.npmrc` reads the tokens from the environment. Do not put a token in a file.

### Configure

```sh
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Value |
|---|---|
| `BETTER_AUTH_URL` | The app URL, for example `http://localhost:3000`. |
| `BETTER_AUTH_SECRET` | A random string of 32 characters or more: `openssl rand -base64 32`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the Google OAuth client. |
| `ALLOWED_EMAILS` | The Google emails that can sign in, separated by commas. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Make them with `npx web-push generate-vapid-keys`. Without them, the app sends no notifications. |
| `ANTHROPIC_API_KEY` | Optional. For the notification summaries. |
| `DATABASE_PATH` | Optional. The default is `./data/dev.db`. |

The Litestream and R2 values are only for production.

### Run

```sh
npm run dev
```

Open `http://localhost:3000` and sign in with Google. The server makes the database and applies the migrations when it starts.

To run the production build:

```sh
npm run build
npm start
```

Push notifications and the offline cache need the production build, because the service worker is registered only in production. On an iPhone, push notifications work only in the app installed on the Home Screen (Share → Add to Home Screen), and only on https.

### Test

```sh
npm run lint
npm run typecheck
npm test
npx playwright install chromium webkit   # one time
npm run test:e2e
```

The e2e tests build the app and start it with a sign-in stub in place of Google, so they need no Google client.

## Deploy

The app runs on one Fly.io machine, behind Cloudflare. Do not add a second machine: the realtime events, the presence, and the notification worker are in memory, and two Litestream replicas damage the backup.

1. Make the Fly app and a volume named `data` in the region of `fly.toml`.
2. Set the secrets with `fly secrets set`: the values from `.env.local` with the production URL, and `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_ENDPOINT` for an R2 bucket. Never set `AUTH_STUB`.
3. Deploy. The Docker build gets the two registry tokens as build secrets:

   ```sh
   fly deploy -a <app> --remote-only --ha=false \
     --build-secret "WEBAWESOME_NPM_TOKEN=$WEBAWESOME_NPM_TOKEN" \
     --build-secret "FONTAWESOME_NPM_AUTH_TOKEN=$FONTAWESOME_NPM_AUTH_TOKEN"
   ```

   The server applies the migrations when it starts. On a new volume, it first restores the database from R2.

CI (`.github/workflows/ci.yml`) runs all checks on each pull request, and deploys each merge to `main` after the checks pass.

To connect Claude, copy the connector URL from Settings → Connected apps, and add it as a custom connector in Claude's settings.
