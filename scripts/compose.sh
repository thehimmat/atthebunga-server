#!/bin/sh
# `docker compose` for this project. Use it for everything (deploy.sh, setup, by hand):
#
#   sh /opt/infra/scripts/compose.sh ps
#
# The API keys are the database's: kosh mints them (its scripts/mint-keys.mjs) and keeps them in its
# selfhost/.env, so that file is read first and this folder's .env second (later wins, so its
# SITE_ADDRESS and COMPOSE_* settings override kosh's). -p and -f are explicit because kosh's .env
# sets COMPOSE_FILE for its own folder.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
kosh_env=${KOSH_ENV:-/opt/kosh/selfhost/.env}
exec docker compose -p atthebunga-server -f "$here/compose.yml" \
  --env-file "$kosh_env" --env-file "$here/.env" "$@"
