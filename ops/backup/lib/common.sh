#!/usr/bin/env bash
set -Eeuo pipefail

log_info() { printf 'INFO %s\n' "$*" >&2; }
log_error() { printf 'ERROR %s\n' "$*" >&2; }

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    log_error "required environment variable ${name} is not set"
    exit 1
  fi
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{print $1}'
  else
    shasum -a 256 "${path}" | awk '{print $1}'
  fi
}

stat_bytes() {
  local path="$1"
  if stat -f%z "${path}" >/dev/null 2>&1; then
    stat -f%z "${path}"
  else
    stat -c%s "${path}"
  fi
}

write_manifest() {
  local path="$1"
  cat >"${path}"
}

looks_like_production_uri() {
  local uri="$1"
  [[ "${uri}" == *"mongodb.net"* ]] \
    || [[ "${uri}" == *"prod"* ]] \
    || [[ "${uri}" == *"production"* ]]
}

# Write a MongoDB Database Tools config so the URI is not passed on argv (visible in ps).
# Prints the config path. Caller must shred/rm after use.
write_mongo_tools_config() {
  local uri="$1"
  local conf
  conf="$(mktemp "${TMPDIR:-/tmp}/nakshathra-mongo-tools-XXXXXX.conf")"
  chmod 600 "${conf}"
  # YAML config supported by mongodump/mongorestore --config
  printf 'uri: %s\n' "${uri}" >"${conf}"
  printf '%s\n' "${conf}"
}

shred_mongo_tools_config() {
  local conf="${1:-}"
  [[ -n "${conf}" && -f "${conf}" ]] || return 0
  if command -v shred >/dev/null 2>&1; then
    shred -u "${conf}" 2>/dev/null || rm -f "${conf}"
  else
    rm -f "${conf}"
  fi
}
