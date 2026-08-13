#!/usr/bin/env bash
# Restore a Nakshathra mongodump archive into an isolated destination.
#
# Oplog / namespace strategy:
# - Archives are created with `mongodump --oplog` (replica-set consistent).
# - Restore uses `mongorestore --oplogReplay` and therefore does NOT remap namespaces.
# - Destination must be an empty replica-set member (or empty matching DB names).
# - A database name in the URI alone is NOT proof of isolation or remapping.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

ARCHIVE_PATH="${1:-}"
ALLOW_PRODUCTION_OVERRIDE="${ALLOW_PRODUCTION_RESTORE:-false}"
MONGO_CONF=""

cleanup() {
  shred_mongo_tools_config "${MONGO_CONF}"
}
trap cleanup EXIT

if [[ -z "${ARCHIVE_PATH}" || ! -f "${ARCHIVE_PATH}" ]]; then
  log_error "usage: restore-mongodb.sh /path/to/backup.archive.gz"
  exit 1
fi

require_env MONGODB_RESTORE_URI

if [[ "${RESTORE_ISOLATED_CONFIRM:-}" != "YES" ]]; then
  log_error "refusing restore: set RESTORE_ISOLATED_CONFIRM=YES after choosing an isolated empty replica set"
  exit 1
fi

if looks_like_production_uri "${MONGODB_RESTORE_URI}" && [[ "${ALLOW_PRODUCTION_OVERRIDE}" != "true" ]]; then
  log_error "refusing restore to production-looking URI without ALLOW_PRODUCTION_RESTORE=true"
  exit 1
fi

if [[ ! -s "${ARCHIVE_PATH}" ]]; then
  log_error "archive is empty"
  exit 1
fi

EXPECTED_SHA="${BACKUP_EXPECTED_SHA256:-}"
if [[ -n "${EXPECTED_SHA}" ]]; then
  ACTUAL_SHA="$(sha256_file "${ARCHIVE_PATH}")"
  if [[ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]]; then
    log_error "sha256 mismatch expected=${EXPECTED_SHA} actual=${ACTUAL_SHA}"
    exit 1
  fi
fi

if [[ "${RESTORE_TARGET_EMPTY_CONFIRMED:-}" != "true" ]]; then
  log_error "refusing restore: set RESTORE_TARGET_EMPTY_CONFIRMED=true after verifying the destination has zero application collections"
  log_error "oplogReplay cannot safely remap namespaces into a non-empty destination"
  exit 1
fi

MONGO_CONF="$(write_mongo_tools_config "${MONGODB_RESTORE_URI}")"

log_info "restoring ${ARCHIVE_PATH} (credentials via tools config, not argv; oplogReplay; no namespace remap)"
mongorestore \
  --config="${MONGO_CONF}" \
  --archive="${ARCHIVE_PATH}" \
  --gzip \
  --oplogReplay

log_info "restore completed"
