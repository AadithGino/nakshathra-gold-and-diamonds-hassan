#!/usr/bin/env bash
# Optional non-secret checks for backup configuration presence.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MISSING=0

check_file() {
  local path="$1"
  if [[ -f "${path}" ]]; then
    echo "OK ${path}"
  else
    echo "MISSING ${path}"
    MISSING=1
  fi
}

check_file "${ROOT}/ops/backup/backup-mongodb.sh"
check_file "${ROOT}/ops/backup/restore-mongodb.sh"
check_file "${ROOT}/ops/backup/verify-backup.sh"
check_file "${ROOT}/ops/backup/apply-retention.sh"
# Single in-repo docs location: <project-root>/docs/
DOCS_ROOT="${ROOT}/docs"
check_file "${DOCS_ROOT}/BACKUP_RESTORE_RUNBOOK.md"
check_file "${DOCS_ROOT}/PRODUCTION_GO_LIVE_CHECKLIST.md"

if ! grep -q 'write_mongo_tools_config' "${ROOT}/ops/backup/lib/common.sh"; then
  echo "MISSING write_mongo_tools_config helper"
  MISSING=1
fi
if grep -qE -- '--uri "\$\{MONGODB_BACKUP_URI\}"' "${ROOT}/ops/backup/backup-mongodb.sh"; then
  echo "FAIL backup-mongodb.sh still passes URI on argv"
  MISSING=1
fi
if ! grep -q 'RESTORE_ISOLATED_CONFIRM' "${ROOT}/ops/backup/restore-mongodb.sh"; then
  echo "MISSING RESTORE_ISOLATED_CONFIRM guard"
  MISSING=1
fi

if [[ -n "${MONGODB_BACKUP_URI:-}" ]]; then
  echo "OK MONGODB_BACKUP_URI is set (value not printed)"
else
  echo "WARN MONGODB_BACKUP_URI not set in this environment (expected on backup host only)"
fi

if grep -RInE 'AtlasApiKey|AWS_SECRET_ACCESS_KEY=[A-Za-z0-9/+=]{16,}|mongodb(\+srv)?://[^:<][^:]*:[^@]+@' \
  "${ROOT}/ops/backup" "${ROOT}/scripts" 2>/dev/null | grep -vE 'verify-backup-config|<\w' ; then
  echo "FAIL possible secrets embedded in ops scripts"
  exit 1
fi

exit "${MISSING}"
