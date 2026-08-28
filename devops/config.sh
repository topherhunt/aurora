#!/usr/bin/env bash
# Shared configuration for Aurora's VPS scripts.
set -euo pipefail
_config_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_config_dir}/deploy.env" ]; then . "${_config_dir}/deploy.env"; fi

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SERVICE_NAME="${SERVICE_NAME:-aurora}"
SERVICE_USER="${SERVICE_USER:-aurora}"
DOMAIN="${DOMAIN:-aurora.topherhunt.com}"
# Reserved now for the future netplay relay.
APP_PORT="${APP_PORT:-3004}"
REMOTE_DIR="${REMOTE_DIR:-/srv/${SERVICE_NAME}}"
REGISTRY_DIR="${REGISTRY_DIR:-/srv/registry}"

require_host() {
  if [ -z "${DEPLOY_HOST}" ]; then echo "ERROR: DEPLOY_HOST is not set." >&2; exit 1; fi
}
remote() { ssh -p "${SSH_PORT}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"; }
remote_sudo() {
  if [ "${DEPLOY_USER}" = root ]; then ssh -p "${SSH_PORT}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@";
  else ssh -p "${SSH_PORT}" "${DEPLOY_USER}@${DEPLOY_HOST}" "sudo $*"; fi
}
