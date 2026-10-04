#!/usr/bin/env bash
# Copy the perf traces the headset uploaded to the VPS into tmp/traces, then
# read them with `node scripts/trace-report.mjs`.
. "$(cd "$(dirname "$0")" && pwd)/config.sh"
require_host
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${REPO_ROOT}/tmp/traces"
if [ "${DEPLOY_USER}" = root ]; then RSYNC_PATH=rsync; else RSYNC_PATH="sudo rsync"; fi
rsync -az --rsync-path="${RSYNC_PATH}" -e "ssh -p ${SSH_PORT}" \
  "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/traces/" "${REPO_ROOT}/tmp/traces/"
ls "${REPO_ROOT}/tmp/traces" | tail -5
