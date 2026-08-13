#!/usr/bin/env bash
# Daily consistent mongodump for Nakshathra (self-hosted replica set Path B).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

require_env MONGODB_BACKUP_URI
require_env BACKUP_LOCAL_DIR

BACKUP_ID="${BACKUP_ID:-nakshathra-$(date -u +%Y%m%dT%H%M%SZ)}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "${BACKUP_LOCAL_DIR}" "${BACKUP_MANIFEST_DIR:-${BACKUP_LOCAL_DIR}/manifests}"

ARCHIVE_PATH="${BACKUP_LOCAL_DIR}/${BACKUP_ID}.archive.gz"
MANIFEST_PATH="${BACKUP_MANIFEST_DIR:-${BACKUP_LOCAL_DIR}/manifests}/${BACKUP_ID}.json"
MONGO_CONF=""

cleanup_on_failure() {
  local exit_code=$?
  shred_mongo_tools_config "${MONGO_CONF}"
  if [[ "${exit_code}" -ne 0 ]]; then
    log_error "backup failed for ${BACKUP_ID} (exit ${exit_code})"
    # Never delete the newest successful backup on failure.
    if [[ -f "${ARCHIVE_PATH}" && ! -f "${MANIFEST_PATH}" ]]; then
      rm -f "${ARCHIVE_PATH}" || true
    fi
  fi
  exit "${exit_code}"
}
trap cleanup_on_failure EXIT

MONGO_CONF="$(write_mongo_tools_config "${MONGODB_BACKUP_URI}")"

log_info "starting mongodump ${BACKUP_ID} (credentials via tools config, not argv)"
mongodump \
  --config="${MONGO_CONF}" \
  --archive="${ARCHIVE_PATH}" \
  --gzip \
  --oplog

shred_mongo_tools_config "${MONGO_CONF}"
MONGO_CONF=""

if [[ ! -s "${ARCHIVE_PATH}" ]]; then
  log_error "backup archive is empty: ${ARCHIVE_PATH}"
  exit 1
fi

MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"
FILE_SIZE="$(stat_bytes "${ARCHIVE_PATH}")"
if [[ "${FILE_SIZE}" -lt "${MIN_BYTES}" ]]; then
  log_error "backup archive suspiciously small (${FILE_SIZE} < ${MIN_BYTES} bytes)"
  exit 1
fi

SHA256="$(sha256_file "${ARCHIVE_PATH}")"
TOOL_VERSION="$(mongodump --version 2>/dev/null | head -n 1 || echo unknown)"
COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DATABASE_NAME="${BACKUP_DATABASE_NAME:-nakshathra}"

write_manifest "${MANIFEST_PATH}" <<EOF
{
  "backupId": "${BACKUP_ID}",
  "startedAt": "${STARTED_AT}",
  "completedAt": "${COMPLETED_AT}",
  "databaseName": "${DATABASE_NAME}",
  "fileName": "$(basename "${ARCHIVE_PATH}")",
  "fileSizeBytes": ${FILE_SIZE},
  "sha256": "${SHA256}",
  "toolVersion": "${TOOL_VERSION}",
  "status": "SUCCESS"
}
EOF

if [[ -n "${BACKUP_UPLOAD_CMD:-}" ]]; then
  log_info "uploading backup via BACKUP_UPLOAD_CMD"
  # Intentionally does not echo secrets; operator supplies a wrapper script.
  bash -c "${BACKUP_UPLOAD_CMD}" -- "${ARCHIVE_PATH}" "${MANIFEST_PATH}"
  if [[ "${BACKUP_REMOVE_LOCAL_AFTER_UPLOAD:-true}" == "true" ]]; then
    rm -f "${ARCHIVE_PATH}"
  fi
fi

log_info "backup completed ${BACKUP_ID} sha256=${SHA256}"
trap - EXIT
