# atthebunga-server

The config for the one server behind At the Bunga's self-hosted sites: an Oracle Cloud Always Free
VM (`kosh-db`, Ashburn, Ampere A1, 2 OCPU / 12 GB (the Always Free A1 allowance), Ubuntu 24.04, `141.148.39.45`).

Live since 2026-11-10, when it took the edge over from gurmukhi-kosh's `selfhost/` folder
([gurmukhi-kosh#395](https://github.com/thehimmat/gurmukhi-kosh/issues/395)). Every merge to `main`
deploys after CI.

## What runs where

This repo owns the **edge**: Caddy on ports 80 and 443 for every name on the box, and the two Next
apps behind search.atthebunga.com. Everything else is a Compose project in its own repo and shares
exactly one network with the gateway, so it reaches the gateway and nothing else.

```
visitor → Cloudflare → gateway :443 ─ search.atthebunga.com → search:3000 ─ rewrites → kosh:3000
                                    ├ stream.atthebunga.com → radio:3001        (radio-edge)
          (Let's Encrypt) ──────────├ <api>, :8080 /rest/v1 → rest:3000         (api-edge)
                                    ├ radio.<api>           → radio:3001        (radio-edge)
                                    └ pir.<api>             → pir-poller:8080   (pir-edge)
```

| Project | Repo, folder on the VM | Shares with the gateway |
|---|---|---|
| This one (`atthebunga-server`): gateway, kosh and search apps | this repo, `/opt/infra` | |
| Database (`selfhost`): Postgres 17 + PostgREST | gurmukhi-kosh `selfhost/`, `/opt/kosh` | `api-edge` (PostgREST as `rest`) |
| Radio streaming server | google-home-radiocaster `streaming-server/selfhost/`, `/opt/radio` | `radio-edge` (`radio`) |
| PIR noise poller | pir-sound-tracker `apps/poller/selfhost/`, `/opt/pir` | `pir-edge` (`pir-poller`) |

The apps reach the API on the gateway's internal listener (`http://gateway:8080`), so database
traffic never leaves the box.

## Files

| File | What it does |
|---|---|
| `compose.yml` | The gateway and the two apps. Networks and Caddy's volume are external (made by `host-setup.sh`). |
| `caddy/Caddyfile` | Shared snippets (`cloudflare_origin`), then every file in `sites/` |
| `sites/api.caddy` | The Supabase-shaped API: `/rest/v1` for a known apikey only, `/health`, the latest backup behind a token |
| `sites/search.caddy` | search.atthebunga.com and kosh.atthebunga.com, for Cloudflare only |
| `sites/stream.caddy` | The radio stack: stream.atthebunga.com (Cloudflare) and `radio.<api>` (direct, for testing) |
| `sites/pir.caddy` | The PIR poller on `pir.<api>`, WebSocket included |
| `scripts/compose.sh` | `docker compose` for this project: pins the name, reads both env files. Always use it. |
| `scripts/deploy.sh` | The deploy keys' forced command: `kosh`, `search`, `kosh-db` or `infra` |
| `scripts/host-setup.sh` | Host setup (packages, firewall, swap, Docker), this checkout, networks, `.env` |
| `tests/` | Static checks of the config and `deploy.sh` (`node --test tests/*.test.mjs`) |

CI runs the tests, shellcheck, `docker compose config` and `caddy validate` (with throwaway
certificates).

## The contract with gurmukhi-kosh

The database stays kosh's: it owns the schema (`supabase/migrations`), mints the keys and runs the
backups. This repo depends on exactly these things from `/opt/kosh`:

- **`selfhost/.env`** holds `ANON_KEY`, `SERVICE_KEY`, `AKHAR_KEY` (all signed with its
  `JWT_SECRET`) and `BACKUP_TOKEN`. `compose.sh` reads it, then this folder's `.env`.
- **`selfhost/backups/`**, mounted read-only into the gateway for `sites/api.caddy`.
- **PostgREST joins `api-edge`** as service `rest`, with its admin server on 3001 (`/ready`).

`sites/api.caddy` is the API's front door, so a change to it is a change to kosh's API. Its live
behaviour is tested by gurmukhi-kosh's `tests/selfhost/gateway.test.ts`; run kosh's
`scripts/check.sh` on the server after changing it.

## Secrets

Two files, both mode 600 and never in git:

- `/opt/kosh/selfhost/.env`: the database's (above). Rotating the service key there
  (kosh's `rotate-service-key.sh`) must also restart this project's gateway and kosh app.
- `/opt/infra/.env` (see `env.example`): `SITE_ADDRESS`, `ADMIN_KEY` (the same curator key as in
  Vercel), and optionally `KOSH_TAG` / `SEARCH_TAG` to pin an older image.

`certs/` holds the Cloudflare certificates (below), also outside git.

## Cloudflare

search.atthebunga.com and stream.atthebunga.com are proxied in **Full (strict)** mode. Caddy holds a
Cloudflare Origin CA certificate (`*.atthebunga.com` and `atthebunga.com`, 15 years, expires
2029-11-01) and requires Cloudflare's client certificate (**Authenticated Origin Pulls, Global**), so
nobody reaches the sites around Cloudflare's cache and rate limit. Files in `/opt/infra/certs/`:

```sh
pbpaste | ssh ubuntu@141.148.39.45 '(umask 077 && cat > /opt/infra/certs/origin.pem)'   # then origin.key the same way
ssh ubuntu@141.148.39.45 'curl -fsS https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem -o /opt/infra/certs/cloudflare-origin-pull-ca.pem'
```

The API name (`141-148-39-45.sslip.io`) and its `radio.` and `pir.` subnames use Let's Encrypt
directly, with no Cloudflare in front.

Zone settings that go with the site: cache rules for `/word/`, `/line/`, `/ang/`, `/api/word/`
(respect the origin's cache headers) and a bypass for curator URLs (`key=` in the query); Bot Fight
Mode **off** (it challenged GitHub's runners); one rate-limiting rule (more than 100 requests in 10 s
per IP on those paths and `/api/` → block 10 s).

## Deploys

Each repo's GitHub Actions SSHes in with a key whose only command is `scripts/deploy.sh`:

| Target | Sent by | Does |
|---|---|---|
| `kosh` | gurmukhi-kosh, new image | update both checkouts, `up` kosh's database project, pull the kosh image, `up` this project, reload Caddy |
| `search` | gurmukhi-search | update this checkout, pull the search image, `up`, reload Caddy |
| `kosh-db` | gurmukhi-kosh, no app change | update `/opt/kosh`, `up` its database project |
| `infra` | this repo | update this checkout, `up`, reload Caddy |

Every target updates this checkout first, so a site change goes live with any deploy. `up` only
recreates what changed, so an app deploy never restarts Postgres. The radio and PIR stacks have
deploy scripts of their own.

The key's line in `~ubuntu/.ssh/authorized_keys`:

```sh
echo "restrict,command=\"sh /opt/infra/scripts/deploy.sh\" $(cat ~/.ssh/kosh-deploy.pub)" | ssh ubuntu@141.148.39.45 'cat >> ~/.ssh/authorized_keys'
```

Repository settings (gurmukhi-kosh, gurmukhi-search, this repo): variable `DEPLOY_HOST` =
`ubuntu@141.148.39.45`; secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`
(`ssh-keygen -F 141.148.39.45 | grep -v '^#'`). The app repos also purge Cloudflare's cache after a
new image (`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`), since cached pages name the old build's chunks.

## Day to day

```sh
ssh ubuntu@141.148.39.45 'sh /opt/infra/scripts/compose.sh logs --tail 100 search kosh'
ssh ubuntu@141.148.39.45 'sh /opt/infra/scripts/compose.sh ps && docker stats --no-stream'
ssh ubuntu@141.148.39.45 'sh /opt/infra/scripts/deploy.sh infra'    # your own key isn't limited to deploy.sh
```

**Roll back one app:** `KOSH_TAG=<sha>` or `SEARCH_TAG=<sha>` in `/opt/infra/.env` (image tags are
commit SHAs), then `deploy.sh infra`. Remove the line to follow `latest` again.

**Add a site for another project:** give that project's Compose file an external network of its
own (e.g. `foo-edge`), add it to `host-setup.sh`'s list and the gateway's `networks:` here, and add
`sites/foo.caddy`. Nothing else on the box can see it.

## A new server

1. `host-setup.sh` (host, networks, this checkout):
   ```sh
   ssh ubuntu@<ip> 'curl -fsSL https://raw.githubusercontent.com/thehimmat/atthebunga-server/main/scripts/host-setup.sh | bash -s -- <ip-with-dashes>.sslip.io'
   ```
2. gurmukhi-kosh's database setup (its `selfhost/README.md`): `.env`, keys, restore, nightly backup.
3. `ADMIN_KEY` in `/opt/infra/.env` and the three files in `certs/` (above).
4. `host-setup.sh` again: it starts the gateway and the apps once nothing is missing.

On a server that's already live, re-running `host-setup.sh` is safe, but its `apt-get full-upgrade`
can restart Docker, which takes every site down for a few seconds. To update only this checkout,
run `deploy.sh infra` instead.
5. The radio and PIR stacks, from their own repos.

## Memory (12 GB)

Postgres has `shared_buffers` 3 GB (kosh's `.env`); each app is capped at 768 MB with a 512 MB
heap (about 80 MB idle); PostgREST and Caddy take about 100 MB each; the radio stack's speech
recognition has a cap of its own (its repo). The rest is the kernel's page cache. Swap is 2 GB.
Check with `docker stats --no-stream`.

**CPU (2 OCPU):** about 1.1 cores in use, almost all the radio's lyrics follower (capped at 1.2 in its
repo); Postgres, the apps and Caddy are near idle. Growing past the Always Free shape is billed on
Pay As You Go: decide that first (#4). It ran at 4 OCPU / 24 GB from 2026-11-07 for a few days.

## Oracle's idle-instance reclaim

Oracle stops Always Free instances it judges idle over 7 days (low CPU, network and, on A1, memory),
and emails first. With the sites on it the VM is less likely to look idle. A Pay As You Go upgrade
takes the instance out of the reclaim and keeps the Always Free allowance at no charge; check
Oracle's [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
page first, and set a $1 budget alert after upgrading.
