# Nakshathra MongoDB backup (Path B — self-hosted)

## What this is

Ops scripts for consistent daily `mongodump --oplog` backups. The API process never runs these.

## Files

| File | Purpose |
| --- | --- |
| `backup-mongodb.sh` | Dump + manifest + optional upload |
| `verify-backup.sh` | Size + SHA-256 (+ manifest) checks |
| `restore-mongodb.sh` | Restore to isolated URI (blocks prod unless override) |
| `apply-retention.sh` | Keep N daily manifests; never deletes newest |
| `nakshathra-mongodb-backup.service` / `.timer` | systemd schedule 02:30 |

## Required env (`/etc/nakshathra/mongodb-backup.env`)

Create as **root-owned mode `0600`**. Never commit this file. Prefer Database Tools /
ops vault injection over copying the API `.env`.

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

Install units:

```bash
sudo install -m 0644 nakshathra-mongodb-backup.service nakshathra-mongodb-backup.timer \
  nakshathra-backup-failure-alert.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nakshathra-mongodb-backup.timer
sudo systemctl list-timers | grep nakshathra
```

Restore drill (isolated empty replica set — must support `--oplogReplay`):

```bash
export MONGODB_RESTORE_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0'
export RESTORE_ISOLATED_CONFIRM=YES
export RESTORE_TARGET_EMPTY_CONFIRMED=true
export BACKUP_EXPECTED_SHA256='...'
./restore-mongodb.sh /path/to/file.archive.gz
```

Credentials are passed via a temporary Database Tools `--config` file (mode `0600`), not `--uri` on argv.

`--oplogReplay` does **not** remap namespaces. Confirm the destination has zero application
collections before setting `RESTORE_TARGET_EMPTY_CONFIRMED=true`.

A successful backup is **not** accepted for go-live until this isolated restore has been demonstrated and recorded in `docs/BACKUP_RESTORE_RUNBOOK.md`.

Production restore requires `ALLOW_PRODUCTION_RESTORE=true` and should be rare.

Before go-live, configure `nakshathra-backup-failure-alert.service` to reach an external admin
channel (webhook/email/SMS), not only `logger`.

## Atlas Path A

If production is Atlas, prefer Atlas automated backups and keep only the runbook + optional `scripts/verify-backup-config.sh`. Do not store API keys in git.
