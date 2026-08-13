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

# Phase 3 — Customer Creation, KYC and Enrollment Conversion

## Objective

Adapt customer onboarding and enrollment for Nakshathra's staff/owner-created customer model while preserving production-grade validation, KYC storage and financial contract snapshots.

## Inspect Before Editing

Read:

- customer model/service/controller/routes
- auth account creation/reset logic
- KYC/Aadhaar storage and presigned upload logic
- nominee fields/models
- enrollment creation service
- active-enrollment indexes
- receipt/passbook number generators
- audit logging
- staff permission middleware from Phase 1

## Required Customer Workflow

Primary flow:

`OWNER/authorized STAFF -> create customer -> create/set login credential -> capture customer profile/KYC -> optionally enroll into scheme`

Customer fields should support:

- name
- mobile number
- password/login credential according to hardened auth architecture
- address
- Aadhaar front reference
- Aadhaar back reference
- nominee information
- customer/passbook number
- account status
- audit metadata

Do not silently weaken password security to match the demo.

## Customer Number / Passbook

Generate a deterministic unique Nakshathra customer/passbook identifier.

Requirements:

- database-enforced uniqueness
- concurrency safe
- no duplicate under simultaneous creation
- business prefix comes from config
- do not derive security/authorization from display number

## KYC

Reuse production KYC mechanisms.

For this phase:

- support Aadhaar front/back references
- keep private storage
- enforce authorization on upload/read
- avoid public object URLs
- keep customer financial operations gated according to the current production KYC policy only if Nakshathra actually requires it
- do not invent a new external KYC provider

## Enrollment

Authorized OWNER/STAFF can enroll customer.

Required checks:

- customer exists and is active
- scheme is active and enabled
- CASH scheme only for current Nakshathra product
- staff has `canEnrollScheme`
- one ACTIVE enrollment per customer if this remains the business rule
- snapshot all contribution policy fields from Phase 2
- calculate start/maturity boundaries in Asia/Kolkata
- no hidden dependency on current mutable SchemePlan after enrollment

## Optional Combined Create + Enroll Flow

If the demo exposes a useful single-step staff workflow, implement it as an orchestration around the same production services, not duplicate business logic.

It must be transactional where partial creation would be harmful.

## APIs

Ensure owner/staff flows can:

- create customer
- view/search customer
- fetch active enrollment
- enroll customer
- fetch enrollment summary
- fetch payment eligibility/preview through Phase 2 service

## Search

Support staff/admin lookup by:

- name
- mobile
- customer/passbook number

Use the production escaped-regex protection already fixed.

No raw user regex.

## Tests Required

- authorized staff creates customer
- unauthorized staff denied
- duplicate mobile rejected safely
- concurrent customer/passbook generation cannot duplicate
- disabled staff denied
- invalid phone rejected without truncation
- customer created without accidental admin/staff authority
- owner enrolls customer
- permitted staff enrolls
- staff without permission denied
- second active enrollment rejected
- enrollment snapshot remains unchanged after SchemePlan edit
- CASH enrollment has no required gold fields
- search treats regex metacharacters literally
- KYC ownership/access regression tests

## Acceptance Gates

- typecheck
- targeted customer/enrollment tests
- auth regressions
- index tests
- build
- transaction/concurrency tests for customer number and active enrollment

## Do Not Change

Do **not**:

- implement staff collection posting yet
- implement cash accountability
- implement correction approvals
- redesign PhonePe
- enable GOLD_WEIGHT live scheme creation
- duplicate cap formula
- expose Aadhaar objects publicly
- allow staff to bypass enrollment service

## Completion Report

Return:

1. customer fields/API contract
2. passbook generation strategy
3. enrollment snapshot fields
4. migrations/indexes
5. tests/counts
6. any deliberate KYC policy retained from production base
