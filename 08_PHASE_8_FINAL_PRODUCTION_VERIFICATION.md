# Nakshathra Jewellers Backend Conversion

## Repository Roles

- **Implementation base:** the audited, production-hardened Kairali backend.
- **Business-logic reference only:** the Nakshathra demo backend.
- **Rule:** never replace the production base with the demo backend and never copy demo weaknesses over production protections.
- **Rule:** the Nakshathra demo must be treated as read-only reference unless this prompt explicitly says otherwise.
- **Current live product:** CASH scheme only.
- **Future-proofing:** keep GOLD_WEIGHT domain support dormant and isolated for future use.
- **Primary roles:** ADMIN/OWNER, STAFF, CUSTOMER.
- **Business timezone:** `Asia/Kolkata`.
- **Target scale:** one jewellery business, about 500 customers, one owner, plus staff.
- **Engineering priority:** preserve financial correctness, auditability, concurrency safety, idempotency, and production hardening over architectural novelty.

## Authoritative Nakshathra Scheme Rules

1. Scheme duration is 11 months.
2. Months 1-6 are flexible contribution months.
3. During months 1-6, multiple successful payments are allowed and there is no monthly cap.
4. Months 7-11 are capped months.
5. Multiple payments are still allowed in a capped month, but their combined successful amount must not exceed that month's cap.
6. The cap calculation must be implemented behind a named strategy. The intended Nakshathra strategy is:
   - `monthlyCap = total successful contribution amount in scheme months 1-6 / count of successful payments in scheme months 1-6`
   - reject/handle the zero-payment denominator safely; never divide by zero.
   - do **not** copy the demo's accidental `total / 6` behavior unless a later explicit business requirement overrides this file.
7. Only successful, non-reversed, financially valid payments participate in contribution totals and cap calculations.
8. The client currently uses CASH schemes. Gold-rate and gold-weight fields must not be required for CASH contributions, maturity, premature closure, or payout.
9. CASH scheme settlement is internally a `PAYOUT`/cash settlement. `REDEEM` is reserved for future GOLD_WEIGHT settlement semantics, even if the customer UI uses the word “redeem.”
10. Scheme rules must be snapshotted onto enrollment so later plan edits do not mutate historical financial contracts.
11. Mobile apps/admin UI must not calculate scheme-month or cap rules themselves. The backend is authoritative.
12. Staff must never directly overwrite posted financial history. Corrections use request -> owner approve/reject -> reversal/replacement where required.

# Phase 8 — Final Production Verification and Release Audit

## Objective

Perform a strict final verification of the converted Nakshathra backend. This phase is primarily verification and only allows narrowly scoped fixes for defects discovered by the gates.

Do not begin new features.

## Preflight

Confirm:

- implementation base is the converted production Kairali backend
- Nakshathra demo remains reference-only
- all Phase 1-7 completion reports exist
- no known incomplete migration
- no knowingly skipped P0/P1 correctness issue

## Static/Build Gates

Run the repository's authoritative commands for:

- dependency install using lockfile
- typecheck
- lint if configured
- unit/Vitest suite
- Jest suite
- build
- migration tests
- index verification tests
- OpenAPI generation/validation if configured

Report exact counts.

## Required Business Acceptance Matrix

### Roles

- owner login
- staff login
- disabled staff denial
- customer login
- staff permission denial/allow paths
- cross-role access isolation

### Customer/Enrollment

- owner creates customer
- staff creates customer with permission
- passbook uniqueness under concurrency
- one active enrollment rule
- snapshot immutability

### 6+5 Scheme

- months 1-6 unlimited/multiple payments
- month 6 -> 7 transition
- cap formula uses successful-payment count, not `/6`
- months 7-11 cap
- exact cap
- over by 1 paise
- zero-payment denominator
- reversed/failed payment exclusion

### Concurrency

- simultaneous capped-month contributions
- duplicate idempotency
- different idempotency keys
- payment vs closure
- duplicate payout
- concurrent cash handovers
- concurrent correction approval

### Payment Channels

- staff CASH
- staff UPI/BANK/CARD
- customer PhonePe
- staff-assisted PhonePe
- PhonePe amount mismatch
- duplicate webhook
- status reconciliation
- late success after closure/maturity

### Cash Accountability

- cash collection increases held amount
- digital does not
- handover reduces held amount
- over-handover fails
- reversal adjusts held amount

### Corrections

- staff cannot edit payment
- request
- reject
- approve
- reversal/replacement
- financial totals remain correct

### CASH Settlement

- maturity
- payout
- premature closure policy
- duplicate/concurrent payout
- no gold dependency

### Reporting

- IST day/month boundaries
- staff attribution
- method breakdown
- payout/cash-held reconciliation

## Financial Integrity

Run the repository's financial integrity checker.

It must report no unresolved production-blocking integrity error.

If it requires a replica-set database, use a safe non-production replica-set environment.

## Migrations

Run:

- migration status/check
- migration apply in safe environment
- rerun/idempotency verification where designed

Never test destructive migration directly against production.

## Indexes

Run real index verification against a safe Mongo replica set.

Confirm critical unique indexes are physically present.

## PhonePe

Before production-ready verdict:

- production environment variables validated
- callback/webhook URL configuration checked
- one controlled low-value production or provider-approved smoke path executed if credentials/environment permit
- never expose secrets in logs/report

If real credentials are unavailable, mark this gate SKIPPED/UNVERIFIED, not PASS.

## Backup / Restore

Run or verify evidence for:

- production-style backup
- checksum
- isolated restore
- financial integrity checker on restored DB

Record result in backup/restore runbook.

## Security Regression

Specifically verify fixes already made in the Kairali base remain:

- atomic failed-login lockout
- strict phone normalization/no truncation
- escaped search regex
- strict integer-paise money parsing
- Asia/Kolkata financial reporting
- valid accounting period month validation

## Final Verdict Format

Return exactly these top-level conclusions:

- `CODE-READY: YES/NO`
- `PRODUCTION-READY: YES/NO`
- `P0 OPEN: <count>`
- `P1 OPEN: <count>`
- `OVERALL SCORE: x/10`

Then provide:

- command results
- test counts
- business-rule acceptance results
- migrations/indexes result
- PhonePe result
- backup/restore result
- financial integrity result
- remaining P2/P3 items
- exact files changed during Phase 8, if any

## Release Rule

Production-ready may be YES only if all code-level P0/P1 defects are closed and every mandatory operational gate is PASS or explicitly accepted by the owner with clear risk.

## Do Not Change

Do **not**:

- refactor working code for style
- add new features
- introduce new architecture
- change scheme formula
- enable GOLD_WEIGHT
- relax tests to make gates green
- mark skipped gates as passed
