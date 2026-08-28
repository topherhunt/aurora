#!/usr/bin/env bash
# Provision Aurora's tenant only. Run host-setup.sh once per VPS first.
. "$(cd "$(dirname "$0")" && pwd)/config.sh"
require_host
echo "==> Provisioning ${SERVICE_NAME}: ${DOMAIN} -> ${REMOTE_DIR} (relay port ${APP_PORT})"
remote_sudo "env SERVICE_NAME='${SERVICE_NAME}' SERVICE_USER='${SERVICE_USER}' DOMAIN='${DOMAIN}' APP_PORT='${APP_PORT}' REMOTE_DIR='${REMOTE_DIR}' REGISTRY_DIR='${REGISTRY_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
if [ -d "${REGISTRY_DIR}" ]; then
  for f in "${REGISTRY_DIR}"/*.app; do
    [ -e "$f" ] || continue
    other_name="$(sed -n 's/^SERVICE_NAME=//p' "$f")"
    other_domain="$(sed -n 's/^DOMAIN=//p' "$f")"
    other_port="$(sed -n 's/^APP_PORT=//p' "$f")"
    if [ "${other_domain}" = "${DOMAIN}" ] && [ "${other_name}" != "${SERVICE_NAME}" ]; then
      echo "ERROR: domain ${DOMAIN} is already registered by ${other_name}." >&2; exit 1
    fi
    if [ "${other_port}" = "${APP_PORT}" ] && [ "${other_name}" != "${SERVICE_NAME}" ]; then
      echo "ERROR: port ${APP_PORT} is already registered by ${other_name}." >&2; exit 1
    fi
  done
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  adduser --system --group --home "${REMOTE_DIR}" --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 755 "${REMOTE_DIR}/dist"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 755 "${REMOTE_DIR}/server"
install -d -m 755 "${REGISTRY_DIR}" /etc/caddy/sites
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=${SERVICE_NAME} WebSocket relay
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${REMOTE_DIR}/server
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=${APP_PORT}
Environment=ROOM_CAP=8
ExecStart=/usr/bin/node ${REMOTE_DIR}/server/src/main.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
cat > "/etc/caddy/sites/${SERVICE_NAME}.caddy" <<CADDY
${DOMAIN} {
	encode zstd gzip
	@health path /health
	handle @health {
		reverse_proxy 127.0.0.1:${APP_PORT}
	}
	handle /ws* {
		reverse_proxy 127.0.0.1:${APP_PORT}
	}
	@v2 path /v2
	rewrite @v2 /v2.html
	@v1 path /v1
	rewrite @v1 /v1.html
	@avatarPreview path /avatar-preview
	rewrite @avatarPreview /avatar-preview.html
	root * ${REMOTE_DIR}/dist
	file_server
}
CADDY
cat > "${REGISTRY_DIR}/${SERVICE_NAME}.app" <<MANIFEST
SERVICE_NAME=${SERVICE_NAME}
DOMAIN=${DOMAIN}
APP_PORT=${APP_PORT}
SERVICE_USER=${SERVICE_USER}
REMOTE_DIR=${REMOTE_DIR}
CADDY_SITE=/etc/caddy/sites/${SERVICE_NAME}.caddy
PROVISIONED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
echo "==> Provisioned. Deploy with devops/deploy.sh"
REMOTE
