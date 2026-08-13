# Production Go-Live Checklist — Nakshathra Jewellers API

Working checklist for the converted Nakshathra production backend. Check an
item only after the named gate has actually been run. Do not check an
operational item off from a code review alone.

## Code gates (this checkout)

Record exact counts in the Phase 8 completion report. Do not check these
off from a previous phase.

- [x] `npx tsc -p tsconfig.json --noEmit` — pass (2026-08-13)
- [x] Vitest unit/integration suite — 56 files, 407 passed
- [x] Jest suite (`npm run test:jest`) — 12 suites, 23 passed
- [x] `npx tsc -p tsconfig.json` build — pass
- [x] Lint — not configured (`N/A`)
- [x] Targeted Phases 1–7 tests already green before Phase 8

## Nakshathra conversion phases

- [x] Phase 1 — domain, role, config
- [x] Phase 2 — 6+5 CASH scheme engine (`AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6`)
- [x] Phase 3 — customer, KYC, enrollment
- [x] Phase 4 — staff portal collections
- [x] Phase 5 — staff PhonePe, cash held, corrections
- [x] Phase 6 — CASH maturity, payout, premature closure
- [x] Phase 7 — owner reports, migrations, indexes, OpenAPI
- [x] Phase 8 — final verification (code-ready vs production-ready are
      separate verdicts)

## Indexes

- [x] Critical index catalog verified against an in-memory Mongo replica set
      (`verifyRequiredIndexes()` / `test/production-index-verification.test.ts`)
- [ ] `npm run indexes:verify` against the real production-bound replica set
      (requires `MONGODB_URI` on a safe non-production replica)

## Financial integrity

- [x] Integrity checker reports no blocking errors on an empty/valid in-memory
      replica set
- [ ] `MONGODB_URI=... npm run integrity-check` against the isolated restore
      target after a real restore drill

## PhonePe

- [ ] Production environment variables validated on the deploy host
      (`PHONEPE_ENABLED`, `PHONEPE_ENV=PRODUCTION`, client id/secret, webhook
      basic auth, `PHONEPE_REDIRECT_URL`)
- [ ] Callback/webhook URL configured at the provider for `/api/v1/webhooks/phonepe`
- [ ] One controlled low-value production or provider-approved smoke path
- [x] Automated PhonePe tests (amount mismatch, duplicate webhook, late success,
      staff-assisted attribution) remain green
- [ ] If credentials are unavailable, this gate stays SKIPPED/UNVERIFIED, not PASS

## Backups & disaster recovery

- [ ] Daily backup timer installed (`nakshathra-mongodb-backup.timer`)
- [ ] Backup failure alert reaches an external channel
- [ ] Isolated restore drill completed and recorded in
      `docs/BACKUP_RESTORE_RUNBOOK.md`
- [x] Retention never deletes the newest successful backup (Jest)

## Secrets & configuration

- [x] No PhonePe/Mongo secrets in this checkout (no committed `.env`)
- [ ] Deploy host `/etc/nakshathra/mongodb-backup.env` is root-owned mode `0600`
- [ ] Production `COOKIE_SECURE=true`, `BOOTSTRAP_DEMO=false`,
      `PHONEPE_DEV_AUTO_SUCCESS=false`
