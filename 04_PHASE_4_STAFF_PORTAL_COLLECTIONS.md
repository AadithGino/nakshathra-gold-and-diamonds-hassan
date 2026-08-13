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

# Phase 4 — Staff Portal, Customer Search, Enrollment Access and Manual Collections

## Objective

Implement the production STAFF operational APIs needed by the Nakshathra staff app: dashboard foundation, customer lookup, enrollment access, payment preview, manual collection and receipt access.

## Inspect Before Editing

Read:

- STAFF auth/permissions from Phase 1
- customer/enrollment APIs from Phase 3
- payment preview and scheme engine from Phase 2
- production manual-payment posting service
- payment idempotency
- receipt generation
- audit logging
- payment ownership/collector fields
- existing Nakshathra demo staff routes as workflow reference only

## Staff Customer Access

Authorized staff with `canViewCustomers` may search/view customers required for collections.

Return only operationally necessary data:

- customer identity/profile summary
- customer/passbook number
- active enrollment
- scheme summary
- total contributed
- current scheme month
- current contribution phase
- cap, paid-this-month, remaining where applicable
- recent payments

Do not expose unrelated secrets or auth hashes.

## Staff Manual Collection

Authorized staff with `canCollectPayment` can post a manual scheme contribution for a selected customer/enrollment.

Supported methods:

- CASH
- UPI
- BANK
- CARD

Record:

- customer id
- enrollment id
- amount in integer paise
- method
- reference where relevant
- payment date/time
- notes
- idempotency key
- collector role = STAFF
- collector id = authenticated staff id
- receipt id/number
- audit metadata

Never trust staff-provided customer ownership or calculated cap values without server revalidation.

## Financial Rules

Every manual payment must go through the same authoritative service as other scheme contributions.

Before commit revalidate:

- enrollment status
- scheme month
- phase
- minimum payment
- capped-month remaining allowance
- idempotency
- duplicate financial identity
- closed/matured/payout state
- concurrency protections

## Payment Date

Do not allow staff to backdate arbitrarily if production policy forbids it.

If manual date is supported:

- validate allowed range
- use Asia/Kolkata
- audit original actor/time
- contribution scheme-month must be derived authoritatively

## Receipt Access

STAFF may retrieve receipts only for payments they collected, unless a broader explicit permission is later added.

CUSTOMER gets own receipts.
ADMIN gets all receipts.

## Staff Dashboard Foundation

Expose an endpoint with at least:

- today's successful collection count
- today's successful collection amount
- method breakdown
- customers served today
- recent collections

Cash-held metrics may remain zero/placeholder until Phase 5 if they depend on cash handover records.

## Tests Required

- staff with permission can search customer
- staff without permission denied
- staff can preview payment
- staff cannot override preview result
- manual CASH payment success
- manual UPI/BANK/CARD success
- minimum payment rejection
- cap rejection
- cap exact limit success
- duplicate idempotency key
- cross-customer tampering rejected
- disabled staff rejected
- receipt ownership isolation
- collector attribution correct
- financial totals include staff collection exactly once
- concurrent staff payments cannot breach cap

## Acceptance Gates

- staff targeted tests
- payment regression tests
- concurrency tests
- typecheck
- build
- audit log assertions
- no duplicated payment engine in staff controller

## Do Not Change

Do **not**:

- add correction request workflow yet
- add cash handover yet
- add staff PhonePe yet unless strictly needed by existing route compilation
- weaken admin/customer payment protections
- implement direct payment edits
- add offline-successful payments
- copy demo payment posting logic over production service

## Completion Report

Return:

1. staff endpoints
2. permission mapping
3. payment methods
4. collector attribution fields
5. tests/counts
6. confirmation all posting flows use central scheme/payment service
