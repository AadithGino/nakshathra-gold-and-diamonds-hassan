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

# Phase 5 — Staff-Assisted PhonePe, Cash Accountability and Correction Requests

## Objective

Add the Nakshathra-specific staff financial workflows that sit on top of the hardened production payment core:

1. staff-assisted PhonePe collections
2. staff cash accountability / handover
3. correction request -> owner approval/rejection

## Part A — Staff-Assisted PhonePe

### Required Flow

`STAFF -> select customer/enrollment -> enter amount -> backend validates scheme rules -> create PhonePe attempt -> provider flow -> hardened verification/finalization -> successful payment attributed to STAFF`

Persist attribution:

- actual customer remains payment owner
- `collectorRole = STAFF`
- `collectorId = staff id`
- channel/source distinguishes staff-assisted PhonePe from customer self-payment

### Reuse Existing Production Hardening

Must reuse:

- payment intent/idempotency
- provider transaction uniqueness
- webhook verification
- provider status re-query
- amount verification
- late-success protection
- reconciliation/recovery
- settlement locking
- financial exception handling

Do not fork a second weak PhonePe implementation.

## Part B — Cash Accountability

### Required Calculation

For each staff member:

`cashHeld = successful staff-collected CASH payments - accepted cash handovers/submissions`

Rules:

- only successful, non-reversed CASH collections count
- reversals must adjust effective held cash correctly
- owner/admin records handover
- handover amount must be > 0
- cannot submit more cash than currently held
- operation must be concurrency safe
- every submission must be audited
- retain immutable history

Suggested record:

- staff id
- amount paise
- submittedAt
- receivedBy admin id
- note/reference
- status if lifecycle needed
- audit metadata

### APIs

Staff:

- view own cash held
- view own handover history

Admin:

- view staff-wise cash held
- record cash received
- view handover history

## Part C — Payment Correction Requests

STAFF may not modify posted payments directly.

Supported request types:

- amount correction
- payment method correction
- payment date correction
- reference correction
- notes correction
- reverse payment

Workflow:

`STAFF creates request -> PENDING -> OWNER APPROVES or REJECTS`

### Approval Semantics

Never overwrite financial history invisibly.

When financial fields change:

- reverse original payment using production reversal semantics
- create corrected replacement payment where applicable
- link correction request, original payment and replacement
- preserve receipt/audit relationships
- revalidate scheme rules for corrected transaction as necessary
- prevent double approval
- use transaction/locking for atomicity

Metadata-only correction can still be auditable; do not mutate immutable financial fields without recorded lineage.

## Tests Required

### Staff PhonePe

- staff permission check
- valid create attempt
- customer ownership correct
- collector attribution correct
- webhook/status success
- amount mismatch
- duplicate callback
- duplicate idempotency
- capped-month revalidation at finalization
- late success after maturity/closure blocked

### Cash Accountability

- cash collection increases held balance
- digital payment does not
- handover decreases balance
- exact full handover allowed
- over-handover rejected
- two concurrent handovers cannot exceed balance
- reversed cash payment adjusts balance correctly
- staff can only view own balance/history
- admin can view all

### Corrections

- staff cannot directly edit payment
- correction request creation
- unauthorized staff denied
- admin reject
- admin approve
- approval idempotent
- original reversed when required
- replacement created once
- linked audit trail
- corrected payment cannot violate cap
- concurrent approvals safe

## Acceptance Gates

- targeted staff PhonePe tests
- existing PhonePe regression suite
- cash-accountability concurrency tests
- correction workflow tests
- typecheck
- build
- financial integrity tests remain green

## Do Not Change

Do **not**:

- create a second PhonePe stack
- directly mutate immutable payment amounts
- allow staff to approve own correction
- make cash handover a simple unguarded decrement
- implement payout/maturity logic here
- add enterprise maker/checker beyond single owner approval
- weaken production payment finalization

## Completion Report

Return:

1. staff PhonePe flow
2. cash balance formula
3. correction lifecycle
4. new models/indexes
5. transaction/locking strategy
6. tests/counts
