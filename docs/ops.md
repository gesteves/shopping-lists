# Operations

Steps for the owner and for agents. The app name and the host are not in this file, because the repository is public: set `FLY_APP` first.

## Backups

- Litestream copies the SQLite database (`/data/shopping-lists.db` on the Fly volume) to the R2 bucket all the time (`litestream.yml`, path `shopping-lists`).
- `scripts/docker-entrypoint.sh` restores from R2 when the volume has no database. If R2 is not available, the machine stops, so a new volume never starts an empty database.
- Each day, the server deletes tombstones and old bookkeeping rows that are older than 30 days (`src/server/purge.ts`).

**Never run the normal entrypoint on a second machine.** It runs `litestream replicate`, and two replicas that write to the same R2 path damage the backup. The machine count in `fly.toml` is one for this reason.

## Restore drill

Do it after a change to the database setup, to Litestream, or to R2, and at least each quarter. The drill only reads from R2. It does not use the volume and does not change the live app.

1. Find the image of the live machine:

   ```sh
   IMAGE=$(fly machines list -a "$FLY_APP" --json | jq -r '.[0].config.image')
   ```

2. Run the drill on a scratch machine. It restores to `/tmp`, checks the database, prints the result, and stops. `--rm` deletes the machine. It has no `--port`, thus it gets no traffic.

   ```sh
   fly machine run "$IMAGE" -a "$FLY_APP" --region iad \
     --entrypoint /usr/local/bin/restore-drill.sh \
     --restart no --rm --vm-memory 512 --name restore-drill
   ```

3. Read the logs. The drill prints only counts and times, no user data:

   ```sh
   fly logs -a "$FLY_APP" --no-tail | grep -A12 integrity_check
   ```

   A good result has `integrity_check: ok`, the migration count of `drizzle/`, row counts near the live counts, a "newest change" from the last minutes of use, and `RESTORE OK`.

4. Check that the scratch machine is gone, and that the app has one machine:

   ```sh
   fly machines list -a "$FLY_APP"
   ```

5. Write the date and the result in the log below.

## Restore the live app

If the volume is lost or damaged:

1. Make a new volume in the same region: `fly volumes create data -a "$FLY_APP" -r iad -s 1`.
2. Destroy the machine that used the old volume, then deploy: `fly deploy -a "$FLY_APP" --remote-only --ha=false`. Or run the GitHub workflow (`workflow_dispatch`).
3. At start, the entrypoint finds no database on the new volume and restores it from R2. Then `/api/health` answers 200.
4. Sign in on a phone. The app pulls all rows again if its cursor is older than the restore.

To go back to an earlier time, add `-timestamp <RFC 3339 time>` to the `litestream restore` command in a drill first. Restore the live app to that time only after the drill shows the right data.

## Drill log

| Date | Result | Notes |
|---|---|---|
| 2026-11-27 | OK | First drill (#20). `integrity_check: ok`, 5 migrations, 2 users, 8 lists, 4 items, 33 activity rows; newest change a few minutes old. The scratch machine was removed, and the app kept one machine. |
