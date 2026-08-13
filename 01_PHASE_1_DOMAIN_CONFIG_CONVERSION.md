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

# Phase 1 — Domain, Role and Configuration Conversion

## Objective

Convert the production Kairali backend from a Kairali-specific domain surface into a Nakshathra-ready production base **without changing the core payment/transaction hardening**.

This phase is deliberately limited to domain/config/role foundations. Do not implement the 6+5 payment engine yet.

## Inspect Before Editing

Identify and read all of the following before changing code:

- root API router and route registration
- auth models, auth services, auth middleware and role guards
- customer/admin/staff models if present
- environment/config modules
- business constants
- receipt/customer/passbook/transaction prefix generators
- S3/KYC key/path helpers
- PhonePe configuration
- OpenAPI/Swagger metadata
- backup/service naming files
- audit-log actor/role typing
- existing dormant STAFF code in Kairali
- existing `CASH` vs `GOLD_WEIGHT` enums or equivalent
- indexes involving role, customer phone, active enrollment or transaction ownership

Produce a short internal inventory before editing so dormant production code is reused where safe instead of duplicated.

## Required Changes

### 1. Business Configuration

Centralize business identity into one configuration layer. At minimum support:

- business display name: Nakshathra Jewellers
- receipt prefix
- customer/passbook prefix
- transaction prefix
- default timezone: Asia/Kolkata
- currency: INR
- enabled scheme types
- enabled roles/features
- PhonePe merchant/provider configuration
- KYC storage namespace/prefix
- support/contact metadata if already modeled

Avoid scattering string replacements across services.

### 2. Enable STAFF as a First-Class Role

Make STAFF an active supported role alongside ADMIN and CUSTOMER.

Required behavior:

- ADMIN/OWNER can create/manage staff.
- STAFF can authenticate.
- STAFF access is permission-gated.
- CUSTOMER must never obtain staff/admin capabilities.
- STAFF must not inherit ADMIN authority merely by role enum ordering or broad middleware.

### 3. Staff Permission Model

Add or normalize these explicit permissions:

- `canCreateCustomer`
- `canViewCustomers`
- `canEnrollScheme`
- `canCollectPayment`
- `canSubmitCorrectionRequest`

Rules:

- default newly created staff permissions must be explicit and safe.
- permission changes must be auditable.
- disabled staff cannot authenticate or act.
- permission checks must happen server-side on every protected operation.

### 4. Scheme-Type Foundation

Retain/introduce:

- `CASH`
- `GOLD_WEIGHT`

For Nakshathra current configuration:

- only `CASH` is enabled for live scheme creation.
- GOLD_WEIGHT models/types may remain but must be dormant.
- do not require gold rate, purity, or gold weight for CASH flows.

### 5. Naming/Brand Conversion

Update only genuine business-specific Kairali identifiers:

- API docs metadata
- receipt/passbook prefixes
- business display names
- internal business constants
- backup/service names where safe
- KYC storage prefixes
- generated-document labels

Do not rename generic financial concepts simply for branding.

## Security and Data Rules

- Preserve the production phone validation and atomic failed-login lockout already fixed in the Kairali base.
- Preserve password hashing, refresh-token, session, rate-limit and audit behavior unless a staff-enablement change strictly requires adaptation.
- No schema downgrade.
- No deletion of existing financial indexes.
- No weakening of auth middleware.
- STAFF authorization must be deny-by-default.

## Migration Requirements

If role enums or business configuration require persisted migration:

- create an idempotent migration.
- do not mutate historical financial records unnecessarily.
- validate existing ADMIN/CUSTOMER records remain valid.
- ensure indexes remain compatible.

## Tests Required

Add/update targeted tests for:

- STAFF valid login.
- disabled STAFF login rejection.
- CUSTOMER cannot access STAFF endpoints.
- STAFF cannot access ADMIN-only endpoints.
- each staff permission denies the operation when false.
- each permission allows the intended operation when true.
- CASH is enabled.
- GOLD_WEIGHT is not selectable for a new Nakshathra live scheme.
- business timezone resolves to Asia/Kolkata.
- Kairali-only generated prefixes/branding are absent from new Nakshathra outputs.
- existing ADMIN and CUSTOMER authentication regression tests remain green.

## Acceptance Gates

Must pass before Phase 2:

- typecheck
- targeted auth/role tests
- relevant Jest/Vitest suites
- build
- migration dry-run or migration tests if a migration was added
- repository scan confirming no accidental broad role bypass

## Do Not Change

Do **not**:

- rewrite PhonePe payment finalization
- rewrite refunds/recovery
- rewrite financial integrity checks
- implement cap arithmetic
- implement staff collection flows
- implement cash accountability
- implement premature closure
- remove GOLD_WEIGHT infrastructure
- add Redis, queues, microservices, or multi-tenant complexity
- copy Nakshathra demo authentication code over hardened Kairali auth

## Completion Report

Return:

1. files changed
2. migrations added
3. STAFF routes now active
4. exact permissions implemented
5. tests/gates with pass/fail counts
6. any unresolved blocker
7. confirmation that no Phase 2+ business logic was implemented
