#!/bin/sh
# The restore drill (#20, docs/ops.md). Run it on a scratch Fly machine, as
# the entrypoint. It restores the newest copy of the database from R2 to a
# temp file, then checks it. It only reads from R2, and it does not use
# /data. Never start `litestream replicate` on a second machine: two
# replicas would write to the same R2 path.
set -eu

for name in LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY R2_BUCKET R2_ENDPOINT DATABASE_PATH; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing env var: $name" >&2
    exit 1
  fi
done

OUT=/tmp/restore-drill.db
litestream restore -config /etc/litestream.yml -o "$OUT" "$DATABASE_PATH"
exec node /usr/local/lib/restore-check.mjs "$OUT"
