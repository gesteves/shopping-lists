#!/bin/sh
# Starts the app on Fly. It starts as root, because the volume is root-owned.
set -eu

DB_DIR=$(dirname "$DATABASE_PATH")
mkdir -p "$DB_DIR"
chown node:node "$DB_DIR"

# Run the rest as the node user.
as_node() {
  setpriv --reuid=node --regid=node --init-groups "$@"
}

# On a new volume, get the database from R2, if a replica exists.
as_node litestream restore -config /etc/litestream.yml \
  -if-db-not-exists -if-replica-exists "$DATABASE_PATH"

# Replicate the database while the server runs. The server applies the
# migrations at boot (src/instrumentation.ts). If the server stops, Litestream
# stops, and Fly restarts the machine.
exec setpriv --reuid=node --regid=node --init-groups \
  litestream replicate -config /etc/litestream.yml -exec "node server.js"
