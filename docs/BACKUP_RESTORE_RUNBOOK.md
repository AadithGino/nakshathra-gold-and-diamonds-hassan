# Backup & Restore Runbook — Nakshathra MongoDB (Path B, self-hosted)

Scripts live in `ops/backup/`. The API process never runs these — they are
invoked by systemd on the backup host only. See `ops/backup/README.md` for the
script/file reference. This runbook is the operational procedure and the
record of the isolated restore drill required before go-live.

## 1. What gets backed up

- `backup-mongodb.sh` runs `mongodump --oplog` against `MONGODB_BACKUP_URI`
  (a replica-set URI), writes a manifest (backup id, file name, SHA-256,
  status) alongside the archive, and optionally hands the archive to
  `BACKUP_UPLOAD_CMD` for offsite storage.
- Credentials are passed via a temporary Database Tools `--config` file
  (mode `0600`, written by `write_mongo_tools_config` in `lib/common.sh`),
  never as `--uri` on argv.
- Scheduled daily at 02:30 via `nakshathra-mongodb-backup.timer` →
  `nakshathra-mongodb-backup.service`. On failure, `OnFailure=` triggers
  `nakshathra-backup-failure-alert.service`.

## 2. Required environment

Create `/etc/nakshathra/mongodb-backup.env`, **root-owned, mode `0600`**. Never
commit this file.

```bash
MONGODB_BACKUP_URI=<replica-set-uri-from-protected-config>
BACKUP_LOCAL_DIR=/var/backups/nakshathra/mongodb
BACKUP_MANIFEST_DIR=/var/backups/nakshathra/mongodb/manifests
BACKUP_DATABASE_NAME=nakshathra
BACKUP_MIN_BYTES=1024
BACKUP_DAILY_KEEP=14
# Optional upload wrapper (no secrets on argv):
# BACKUP_UPLOAD_CMD=/usr/local/bin/nakshathra-upload-backup.sh
```

## 3. Install

```bash
sudo install -m 0644 nakshathra-mongodb-backup.service nakshathra-mongodb-backup.timer \
  nakshathra-backup-failure-alert.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nakshathra-mongodb-backup.timer
sudo systemctl list-timers | grep nakshathra
```

Before go-live, configure `nakshathra-backup-failure-alert.service` to reach an
external admin channel (webhook/email/SMS), not only local `logger` output.

## 4. Verifying a backup

`verify-backup.sh` checks archive size against `BACKUP_MIN_BYTES` and, when a
manifest is supplied, validates the recorded SHA-256 against the actual
archive. It rejects empty/zero-byte archives. Run it after every backup job.

## 5. Retention

`apply-retention.sh` keeps the most recent `BACKUP_DAILY_KEEP` manifests
(default 14) and deletes older archive+manifest pairs. It always protects the
newest successful backup from deletion.

## 6. Restoring

Restores default to blocking anything that looks like a production URI.

```bash
export MONGODB_RESTORE_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0'
export RESTORE_ISOLATED_CONFIRM=YES
export RESTORE_TARGET_EMPTY_CONFIRMED=true
export BACKUP_EXPECTED_SHA256='<sha256 from the manifest>'
./restore-mongodb.sh /path/to/file.archive.gz
```

After restore, run the read-only integrity checker against the isolated URI
(never against production):

```bash
MONGODB_URI="$MONGODB_RESTORE_URI" npm run integrity-check
```

## 7. Isolated restore drill — go-live requirement

A successful scheduled backup is **not sufficient** for go-live. Record each
drill here:

| Date | Operator | Backup verified (sha256 match) | Restore target | Integrity check | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-13 | Phase 8 verification (this checkout) | Script tests only (`verify-backup.sh` empty-archive reject + sha256 match in Jest) | No production or disposable mongod available in this checkout | In-memory replica-set checker green on empty/valid CASH fixture; live restored-DB checker not run | SKIPPED / UNVERIFIED | Live `mongodump`/`mongorestore` drill must be executed on the backup host against an isolated empty replica set before production-ready can be YES. |

Drill procedure:

1. Take (or reuse) a recent backup archive + manifest.
2. `verify-backup.sh <archive> <manifest>` — must exit 0.
3. Spin up a throwaway empty single-node replica set. Never production.
4. Run `restore-mongodb.sh` with `RESTORE_ISOLATED_CONFIRM=YES` and
   `RESTORE_TARGET_EMPTY_CONFIRMED=true`.
5. `MONGODB_URI=<restore-uri> npm run integrity-check` must report `ok: true`
   with no production-blocking errors.
6. Tear down the throwaway instance and record the result above.

## 8. Atlas Path A (alternative)

If production is MongoDB Atlas, prefer Atlas automated backups. Keep this
runbook and optionally `scripts/verify-backup-config.sh`. Never store Atlas
API keys in git.
