#!/usr/bin/env bash
# Shared VPS setup. Safe to run when other tenants already use this host.
. "$(cd "$(dirname "$0")" && pwd)/config.sh"
require_host
remote_sudo "env NODE_MAJOR='${NODE_MAJOR:-22}' SSH_PORT='${SSH_PORT}' bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y rsync git curl ca-certificates gnupg ufw fail2ban unattended-upgrades build-essential python3
# Do not enable or change UFW policy here: this host is shared, and an existing operator may have
# intentionally opened another tenant's port. The Caddy site only needs 80/443; configure firewall
# policy separately after auditing the current rules.
systemctl enable --now fail2ban
systemctl enable --now unattended-upgrades 2>/dev/null || true
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y; apt-get install -y caddy
fi
install -d -m 755 /etc/caddy/sites /srv/registry
if [ ! -f /etc/caddy/Caddyfile ]; then
  printf '%s\n' 'import /etc/caddy/sites/*.caddy' > /etc/caddy/Caddyfile
elif ! grep -Fq 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile; then
  printf '\n# Per-tenant sites\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy; systemctl reload caddy
echo 'Shared setup complete; existing tenant files and services were left in place.'
REMOTE
