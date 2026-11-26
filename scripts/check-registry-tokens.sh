#!/bin/sh
# Stop with a clear message if a registry token is missing (#51). Without
# it, `npm ci` fails with "E401 ... npm login", which does not say why.
missing=""
[ -n "$WEBAWESOME_NPM_TOKEN" ] || missing="$missing WEBAWESOME_NPM_TOKEN"
[ -n "$FONTAWESOME_NPM_AUTH_TOKEN" ] || missing="$missing FONTAWESOME_NPM_AUTH_TOKEN"
if [ -n "$missing" ]; then
  echo "Missing registry tokens:$missing" >&2
  echo "Set them in the env (CI: repository secrets; Docker: build secrets)." >&2
  echo "The Pro packages come from private registries (.npmrc, #51)." >&2
  exit 1
fi
