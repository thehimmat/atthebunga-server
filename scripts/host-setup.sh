#!/bin/bash
# Setup of the VM's host and its gateway (Oracle Ampere A1, Ubuntu 24.04, as the `ubuntu` user).
# Safe to re-run: it updates the code and keeps existing secrets. From a Mac:
#
#   ssh ubuntu@<ip> 'curl -fsSL https://raw.githubusercontent.com/thehimmat/atthebunga-server/main/scripts/host-setup.sh | bash -s -- <api-domain>'
#
# <api-domain> is the API's public name, which Caddy gets a Let's Encrypt certificate for. Without a
# domain, use <ip-with-dashes>.sslip.io (e.g. 141-148-39-45.sslip.io), which resolves to the IP.
#
# On a new VM, run in this order (README, "A new server"):
#   1. this script            host, networks, this checkout (doesn't start the gateway yet)
#   2. kosh's db-setup        database stack, its .env and keys, nightly backup
#   3. this script again      starts the gateway and apps once kosh's .env, ADMIN_KEY and certs exist
#
# INFRA_NO_START=1 skips starting the stack (used on the cutover, while the old gateway holds 80/443).
set -euo pipefail

site=${1:?usage: host-setup.sh <api-domain>}
branch=${INFRA_BRANCH:-main}
dir=/opt/infra
kosh_env=${KOSH_ENV:-/opt/kosh/selfhost/.env}

echo "== packages and automatic security updates"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get -y -qq full-upgrade
sudo DEBIAN_FRONTEND=noninteractive apt-get -y -qq install docker.io docker-compose-v2 git unattended-upgrades gnupg
# Security updates install daily; a kernel update reboots at 04:30 UTC, and every stack restarts itself.
sudo tee /etc/apt/apt.conf.d/52server-unattended >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
sudo systemctl enable --now unattended-upgrades docker
sudo usermod -aG docker ubuntu # takes effect from the next SSH login

echo "== firewall: ports 80 and 443 (Oracle's image rejects everything but SSH)"
for port in 443 80; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    reject=$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
    sudo iptables -I INPUT "${reject:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null; fi

echo "== swap (2 GB, for pg_restore and index builds)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap -q /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== code ($branch)"
sudo install -d -o ubuntu -g ubuntu "$dir"
if [ -d "$dir/.git" ]; then
  git -C "$dir" fetch -q origin "$branch" && git -C "$dir" checkout -q -B "$branch" "origin/$branch"
else
  git clone -q --branch "$branch" https://github.com/thehimmat/atthebunga-server.git "$dir"
fi

echo "== edge networks and Caddy's volume"
# One network per neighbour, so each reaches the gateway and nothing else (compose.yml).
for net in api-edge radio-edge pir-edge; do
  sudo docker network inspect "$net" >/dev/null 2>&1 || sudo docker network create "$net" >/dev/null
done
sudo docker volume inspect selfhost_caddy_data >/dev/null 2>&1 || sudo docker volume create selfhost_caddy_data >/dev/null

echo "== settings (.env, never printed)"
env_file=$dir/.env
if [ ! -f "$env_file" ]; then
  (umask 077 && echo "SITE_ADDRESS=$site" > "$env_file")
elif grep -q '^SITE_ADDRESS=' "$env_file"; then
  sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$site|" "$env_file"
else
  echo "SITE_ADDRESS=$site" >> "$env_file"
fi
install -d -m 700 "$dir/certs"

missing=()
[ -f "$kosh_env" ] || missing+=("kosh's $kosh_env (run kosh's db-setup)")
grep -q '^ADMIN_KEY=.' "$env_file" || missing+=("ADMIN_KEY in $env_file (README, \"Secrets\")")
for f in origin.pem origin.key cloudflare-origin-pull-ca.pem; do
  [ -s "$dir/certs/$f" ] || missing+=("$dir/certs/$f (README, \"Cloudflare\")")
done

if [ -n "${INFRA_NO_START:-}" ]; then
  echo "== stack: not started (INFRA_NO_START)"
elif [ ${#missing[@]} -gt 0 ]; then
  echo "== stack: not started yet; missing:"
  printf '   - %s\n' "${missing[@]}"
else
  echo "== stack"
  sudo sh "$dir/scripts/compose.sh" up -d --quiet-pull --wait
  sudo sh "$dir/scripts/compose.sh" ps --format '{{.Service}}: {{.Status}}'
fi
