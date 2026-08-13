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

# Phase 7 — Owner/Admin Controls, Reporting, Indexes, Migrations and API Documentation

## Objective

Complete Nakshathra owner operations and reporting, remove remaining Kairali-specific business assumptions, and make the repository migratable/documented without adding enterprise-scale complexity.

## Owner/Admin Controls

Ensure the single ADMIN/OWNER can manage:

- customers
- staff
- staff permissions/status
- scheme plans
- enrollments
- payments
- staff correction requests
- cash handovers
- payouts/premature closure
- reports
- audit records
- configuration/settings already supported
- PhonePe transaction/reconciliation views already supported

Do not add multi-admin maker/checker architecture for this deployment.

## Staff Management

Owner can:

- create staff
- enable/disable staff
- reset staff credentials using hardened auth patterns
- update granular permissions
- inspect staff collection summary
- inspect staff cash held/submitted
- inspect correction request history

All changes audited.

## Reporting

Provide bounded, production-safe reports for approximately 500 customers.

Required views:

- daily collections
- monthly collections
- scheme-wise collection
- payment-method breakdown
- customer self-payment vs staff-collected
- staff-wise collection
- staff cash held
- staff cash submission history
- payout/closure totals
- correction request status/history

Timezone:

- all day/month ranges use Asia/Kolkata
- reuse the shared fixed timezone utilities
- never use server-local `new Date(year, month...)` reporting boundaries

## Pagination / Boundedness

Do not perform a large redesign, but owner/staff list/report endpoints should have sane bounded pagination/default limits.

For this 500-customer deployment, simple capped pagination is enough.

## Data Migration

Create idempotent migrations needed to convert Kairali production data/schema assumptions to Nakshathra structures.

Migration goals may include:

- role enum/staff activation
- scheme contribution policy fields
- CASH/GOLD_WEIGHT type normalization
- enrollment snapshots
- collector attribution fields
- correction/cash-submission collections/indexes
- business prefixes/config
- state enum additions

Rules:

- no destructive migration without explicit reason
- preserve financial history
- migration rerun must be safe
- add rollback notes where feasible
- indexes created explicitly and verified

## Index Verification

Update the critical index manifest/verifier for all new financial uniqueness/concurrency indexes.

Candidate areas:

- staff login identity
- customer phone
- passbook/customer number
- active enrollment uniqueness
- payment collector/date
- payment enrollment/scheme-month
- cash submission staff/date
- correction request status/payment
- payout uniqueness

## OpenAPI / Swagger

Update docs for:

- STAFF auth
- staff permissions
- customer creation/search
- enrollment
- payment preview
- manual collection
- staff PhonePe
- cash accountability
- correction requests
- CASH payout/premature closure
- owner reports

Clearly mark future GOLD_WEIGHT functionality as disabled/not part of current Nakshathra live product.

## Residual Kairali Scan

Search source/docs/config/tests for business-specific Kairali assumptions.

Classify each hit:

- must change to generic/Nakshathra
- intentionally generic legacy name safe to retain
- test fixture only
- dead code to remove only if safe

Do not rename stable generic DB concepts merely to make the grep empty.

## Tests Required

- admin staff-management tests
- permission update tests
- reports use IST boundaries
- report totals reconcile with payment data
- staff/self-payment attribution reports
- cash-held report
- correction status report
- payout report
- pagination/default limits
- migration tests
- index verification tests
- OpenAPI route coverage smoke if available

## Acceptance Gates

- migrations test/dry-run
- indexes:verify against safe replica-set DB if available
- report tests
- admin tests
- typecheck
- unit/Jest
- build
- residual Kairali scan reviewed

## Do Not Change

Do **not**:

- add complex BI/warehouse infrastructure
- add multi-tenant abstractions beyond simple business config needed now
- add distributed caches
- add maker/checker hierarchy
- redesign payment core
- silently delete historical Kairali data structures if migration compatibility is needed

## Completion Report

Return:

1. owner endpoints/features
2. reports added
3. pagination policy
4. migrations
5. indexes
6. OpenAPI coverage changes
7. residual Kairali references with disposition
8. tests/counts
