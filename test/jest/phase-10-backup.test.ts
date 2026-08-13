import { describe, expect, it } from '@jest/globals';
import { readFileSync, chmodSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const backupDir = join(__dirname, '../../ops/backup');

function read(name: string) {
  return readFileSync(join(backupDir, name), 'utf8');
}

describe('Phase 10 — backup ops scripts', () => {
  it('ships hardened backup/restore scripts with pipefail and production restore guard', () => {
    for (const name of [
      'backup-mongodb.sh',
      'restore-mongodb.sh',
      'verify-backup.sh',
      'apply-retention.sh',
      'lib/common.sh',
    ]) {
      expect(existsSync(join(backupDir, name))).toBe(true);
      expect(read(name)).toContain('set -Eeuo pipefail');
    }
    expect(read('restore-mongodb.sh')).toContain('ALLOW_PRODUCTION_RESTORE');
    expect(read('restore-mongodb.sh')).toContain('refusing restore to production-looking URI');
    expect(read('restore-mongodb.sh')).toContain('RESTORE_ISOLATED_CONFIRM');
    expect(read('restore-mongodb.sh')).toContain('RESTORE_TARGET_EMPTY_CONFIRMED');
    expect(read('restore-mongodb.sh')).toContain('--config=');
    expect(read('backup-mongodb.sh')).toContain('--config=');
    expect(read('backup-mongodb.sh')).not.toContain('--uri "${MONGODB_BACKUP_URI}"');
    expect(read('lib/common.sh')).toContain('write_mongo_tools_config');
    expect(read('apply-retention.sh')).toContain('protecting newest successful backup');
    expect(read('nakshathra-mongodb-backup.service')).toContain('OnFailure=');
    expect(existsSync(join(backupDir, 'nakshathra-backup-failure-alert.service'))).toBe(true);
    expect(existsSync(join(__dirname, '../../docs/BACKUP_RESTORE_RUNBOOK.md'))).toBe(true);
    expect(existsSync(join(__dirname, '../../docs/PRODUCTION_GO_LIVE_CHECKLIST.md'))).toBe(true);
  });

  it('verify-backup rejects empty archives and validates sha256 manifests', () => {
    chmodSync(join(backupDir, 'verify-backup.sh'), 0o755);
    const dir = mkdtempSync(join(tmpdir(), 'kairali-backup-'));
    const empty = join(dir, 'empty.archive.gz');
    writeFileSync(empty, '');
    const emptyRun = spawnSync('bash', [join(backupDir, 'verify-backup.sh'), empty], {
      encoding: 'utf8',
    });
    expect(emptyRun.status).not.toBe(0);

    const good = join(dir, 'good.archive.gz');
    writeFileSync(good, 'x'.repeat(2048));
    const sha = spawnSync('shasum', ['-a', '256', good], { encoding: 'utf8' }).stdout.split(' ')[0];
    const manifest = join(dir, 'good.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        backupId: 't',
        sha256: sha,
        fileName: 'good.archive.gz',
        status: 'SUCCESS',
      }),
    );
    const okRun = spawnSync(
      'bash',
      [join(backupDir, 'verify-backup.sh'), good, manifest],
      { encoding: 'utf8', env: { ...process.env, BACKUP_MIN_BYTES: '1024' } },
    );
    expect(okRun.status).toBe(0);

    const restore = spawnSync(
      'bash',
      [join(backupDir, 'restore-mongodb.sh'), good],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          MONGODB_RESTORE_URI: 'mongodb+srv://user:pass@cluster.mongodb.net/prod',
          RESTORE_ISOLATED_CONFIRM: 'YES',
          RESTORE_TARGET_EMPTY_CONFIRMED: 'true',
        },
      },
    );
    expect(restore.status).not.toBe(0);
    expect(restore.stderr + restore.stdout).toMatch(/refusing restore/i);

    const missingConfirm = spawnSync(
      'bash',
      [join(backupDir, 'restore-mongodb.sh'), good],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          MONGODB_RESTORE_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
        },
      },
    );
    expect(missingConfirm.status).not.toBe(0);
    expect(missingConfirm.stderr + missingConfirm.stdout).toMatch(/RESTORE_ISOLATED_CONFIRM/i);
  });

  it('retention never deletes the newest successful backup', () => {
    chmodSync(join(backupDir, 'apply-retention.sh'), 0o755);
    const dir = mkdtempSync(join(tmpdir(), 'kairali-retention-'));
    const manifests = join(dir, 'manifests');
    mkdirSync(manifests);
    for (const id of ['a', 'b', 'c']) {
      writeFileSync(join(dir, `${id}.archive.gz`), id.repeat(100));
      writeFileSync(
        join(manifests, `${id}.json`),
        JSON.stringify({ fileName: `${id}.archive.gz`, status: 'SUCCESS', backupId: id }),
      );
      // ensure mtime ordering: sleep not needed if we touch via sequential writes + rename times
    }
    // Force newest by rewriting c last
    writeFileSync(
      join(manifests, 'c.json'),
      JSON.stringify({ fileName: 'c.archive.gz', status: 'SUCCESS', backupId: 'c' }),
    );

    const run = spawnSync('bash', [join(backupDir, 'apply-retention.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKUP_LOCAL_DIR: dir,
        BACKUP_MANIFEST_DIR: manifests,
        BACKUP_DAILY_KEEP: '1',
      },
    });
    expect(run.status).toBe(0);
    expect(existsSync(join(manifests, 'c.json'))).toBe(true);
    expect(existsSync(join(dir, 'c.archive.gz'))).toBe(true);
  });
});
