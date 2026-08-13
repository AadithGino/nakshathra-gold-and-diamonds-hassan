#!/usr/bin/env bash
# Verify a backup archive + optional manifest before restore drills.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

ARCHIVE_PATH="${1:-}"
MANIFEST_PATH="${2:-}"

if [[ -z "${ARCHIVE_PATH}" || ! -f "${ARCHIVE_PATH}" ]]; then
  log_error "usage: verify-backup.sh /path/to/backup.archive.gz [/path/to/manifest.json]"
  exit 1
fi

if [[ ! -s "${ARCHIVE_PATH}" ]]; then
  log_error "archive is empty"
  exit 1
fi

MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"
FILE_SIZE="$(stat_bytes "${ARCHIVE_PATH}")"
if [[ "${FILE_SIZE}" -lt "${MIN_BYTES}" ]]; then
  log_error "archive suspiciously small (${FILE_SIZE} < ${MIN_BYTES})"
  exit 1
fi

SHA256="$(sha256_file "${ARCHIVE_PATH}")"
log_info "archive ok size=${FILE_SIZE} sha256=${SHA256}"

if [[ -n "${MANIFEST_PATH}" ]]; then
  if [[ ! -f "${MANIFEST_PATH}" ]]; then
    log_error "manifest not found: ${MANIFEST_PATH}"
    exit 1
  fi
  MANIFEST_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "${MANIFEST_PATH}")"
  if [[ "${MANIFEST_SHA}" != "${SHA256}" ]]; then
    log_error "manifest sha256 mismatch"
    exit 1
  fi
  log_info "manifest sha256 verified"
fi
