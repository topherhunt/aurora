#!/usr/bin/env bash
# Build locally and publish only the static artifact for this tenant.
. "$(cd "$(dirname "$0")" && pwd)/config.sh"
require_host
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
( cd "${REPO_ROOT}" && npm run build )
( cd "${REPO_ROOT}" && printf '{"commit":"%s","dirtyFiles":%s}\n' "$(git rev-parse --short HEAD)" "$(git status --porcelain | wc -l | tr -d ' ')" > dist/build.json )
if [ "${DEPLOY_USER}" = root ]; then RSYNC_PATH=rsync; else RSYNC_PATH="sudo rsync"; fi
rsync -az --delete --delay-updates --rsync-path="${RSYNC_PATH}" -e "ssh -p ${SSH_PORT}" \
  "${REPO_ROOT}/dist/" "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/dist/"
rsync -az --delete --delay-updates --rsync-path="${RSYNC_PATH}" -e "ssh -p ${SSH_PORT}" \
  "${REPO_ROOT}/server/" "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/server/"
remote_sudo "chown -R '${SERVICE_USER}:${SERVICE_USER}' '${REMOTE_DIR}/dist'"
# The source tree contains generated assets with restrictive local modes. Normalize the published
# read-only artifact so Caddy's separate user can traverse directories and read every asset.
remote_sudo "find '${REMOTE_DIR}/dist' -type d -exec chmod 755 {} +"
remote_sudo "find '${REMOTE_DIR}/dist' -type f -exec chmod 644 {} +"
remote_sudo "chown -R '${SERVICE_USER}:${SERVICE_USER}' '${REMOTE_DIR}/server'"
remote_sudo "install -d -o '${SERVICE_USER}' -g '${SERVICE_USER}' '/tmp/${SERVICE_NAME}-npm-cache' '/tmp/${SERVICE_NAME}-home'"
if [ "${DEPLOY_USER}" = root ]; then
  remote "runuser -u '${SERVICE_USER}' -- env HOME='/tmp/${SERVICE_NAME}-home' NPM_CONFIG_CACHE='/tmp/${SERVICE_NAME}-npm-cache' npm ci --omit=dev --prefix '${REMOTE_DIR}/server' --no-audit --no-fund"
else
  remote "sudo -u '${SERVICE_USER}' env HOME='/tmp/${SERVICE_NAME}-home' NPM_CONFIG_CACHE='/tmp/${SERVICE_NAME}-npm-cache' npm ci --omit=dev --prefix '${REMOTE_DIR}/server' --no-audit --no-fund"
fi
remote_sudo systemctl restart "${SERVICE_NAME}.service"
health_ok=0
for attempt in $(seq 1 15); do
  if health_body="$(curl -fsS --max-time 5 "https://${DOMAIN}/health" 2>/dev/null)"; then
    printf '%s\n' "${health_body}"
    health_ok=1
    break
  fi
  echo "Waiting for public health check (${attempt}/15)..." >&2
  sleep 1
done
if [ "${health_ok}" -ne 1 ]; then
  echo >&2 "ERROR: public health check failed. Inspect: sudo systemctl status ${SERVICE_NAME}.service"
  exit 1
fi
echo "==> Deployed: https://${DOMAIN}/ at $(date "+%Y-%m-%d %H:%M")"
