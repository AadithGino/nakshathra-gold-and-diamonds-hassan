#!/usr/bin/env bash
# Apply retention policy without deleting the newest successful backup.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

require_env BACKUP_LOCAL_DIR
MANIFEST_DIR="${BACKUP_MANIFEST_DIR:-${BACKUP_LOCAL_DIR}/manifests}"
DAILY_KEEP="${BACKUP_DAILY_KEEP:-14}"

mkdir -p "${MANIFEST_DIR}"

# Portable listing (bash 3 + bash 4): newest first.
MANIFESTS=()
while IFS= read -r line; do
  MANIFESTS+=("${line}")
done < <(ls -1t "${MANIFEST_DIR}"/*.json 2>/dev/null || true)

if [[ "${#MANIFESTS[@]}" -eq 0 ]]; then
  log_info "no manifests found; nothing to prune"
  exit 0
fi

NEWEST="${MANIFESTS[0]}"
log_info "protecting newest successful backup manifest: ${NEWEST}"

# Keep newest DAILY_KEEP manifests; never delete index 0.
i=0
for MANIFEST in "${MANIFESTS[@]}"; do
  if [[ "${i}" -lt "${DAILY_KEEP}" ]]; then
    i=$((i + 1))
    continue
  fi
  FILE_NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("fileName",""))' "${MANIFEST}")"
  if [[ -n "${FILE_NAME}" && -f "${BACKUP_LOCAL_DIR}/${FILE_NAME}" ]]; then
    log_info "removing old archive ${FILE_NAME}"
    rm -f "${BACKUP_LOCAL_DIR}/${FILE_NAME}"
  fi
  log_info "removing old manifest ${MANIFEST}"
  rm -f "${MANIFEST}"
  i=$((i + 1))
done

log_info "retention complete; newest retained"
