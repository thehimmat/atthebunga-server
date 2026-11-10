#!/bin/sh
# Deploys on the server. It's the forced command of each GitHub Actions deploy key (README,
# "Deploys"), which sends the target as its SSH command:
#
#   ssh ubuntu@<ip> kosh      # new gurmukhi-kosh image (and its database config)
#   ssh ubuntu@<ip> search    # new gurmukhi-search image
#   ssh ubuntu@<ip> kosh-db   # gurmukhi-kosh's database config only (a push with no app change)
#   ssh ubuntu@<ip> infra     # this repo's config only
#
# Always updates this checkout to main first, so a site or compose change is live with any deploy.
# Then brings the stack up, waiting for health checks, and reloads Caddy in place.
set -eu
target=${SSH_ORIGINAL_COMMAND:-${1:-}}
case "$target" in
  kosh | search | kosh-db | infra) ;;
  *)
    echo "usage: deploy.sh kosh|search|kosh-db|infra" >&2
    exit 2
    ;;
esac
echo "deploy $target"
[ -z "${DEPLOY_DRY_RUN:-}" ] || exit 0

here=$(cd "$(dirname "$0")/.." && pwd)
kosh_dir=${KOSH_DIR:-/opt/kosh}
compose="$here/scripts/compose.sh"

update() {
  git -C "$1" fetch -q origin main
  git -C "$1" checkout -q -B main origin/main
}

update "$here"

# kosh's database stack (Postgres + PostgREST) is its own Compose project in its own checkout.
# `up` there changes nothing unless its config did, so Postgres isn't restarted for an app deploy.
if [ "$target" = kosh ] || [ "$target" = kosh-db ]; then
  update "$kosh_dir"
  (cd "$kosh_dir/selfhost" && docker compose up -d --quiet-pull --wait)
fi
[ "$target" != kosh-db ] || exit 0

if [ "$target" = kosh ] || [ "$target" = search ]; then
  sh "$compose" pull -q "$target"
fi
sh "$compose" up -d --quiet-pull --wait
sh "$compose" exec -T gateway caddy reload --config /etc/caddy/Caddyfile
docker image prune -f >/dev/null
sh "$compose" ps --format '{{.Service}}: {{.Status}}'
