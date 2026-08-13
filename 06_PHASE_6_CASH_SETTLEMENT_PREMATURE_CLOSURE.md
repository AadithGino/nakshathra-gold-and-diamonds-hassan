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

# Phase 6 — CASH Maturity Settlement, Payout and Premature Closure

## Objective

Implement Nakshathra's current CASH-scheme completion/settlement lifecycle while keeping GOLD_WEIGHT redemption dormant for future use.

## Terminology

Internal accounting:

- CASH scheme completion -> `PAYOUT` / cash settlement
- GOLD_WEIGHT future completion -> `REDEEM`

Customer UI may use “Redeem Scheme” for cash if desired, but backend financial semantics must remain payout-based.

## Inspect Before Editing

Read:

- current Kairali maturity logic
- payout/redemption services
- premature closure service if present
- payment-vs-closure concurrency guards
- settlement locks
- financial integrity checker
- late PhonePe success handling
- enrollment state machine
- accounting/audit integration

## Enrollment Lifecycle

Support a clear CASH lifecycle such as:

- ACTIVE
- MATURED
- PAYOUT_PENDING if needed
- CLOSED

Premature path may use:

- ACTIVE
- PREMATURE_CLOSURE_REQUESTED if request flow is required
- CLOSED after settlement

Do not invent unnecessary states if existing state machine cleanly supports equivalent semantics.

## Maturity

Maturity must derive from enrollment snapshot and Asia/Kolkata business time.

Once no longer payable:

- new contributions rejected
- pending/late provider success must not improperly resurrect payment eligibility
- maturity should not alter historical contribution records

## CASH Payout

Payout fields should include:

- enrollment
- customer
- payable amount paise
- settlement method: CASH / BANK / UPI as supported
- reference
- actor/admin
- status
- timestamps
- idempotency/unique identity
- audit linkage

Rules:

- one completed financial settlement per closure event
- duplicate payout rejected/idempotent
- payout amount derived server-side from authoritative scheme/closure calculation
- no gold rate or grams required

## Premature Closure

Implement policy abstraction rather than hardcoding financial penalty arithmetic into controller/payment service.

Create a clear policy boundary, e.g.:

- `PrematureClosurePolicy`
- `calculatePrematureClosureSettlement(...)`

If the exact Nakshathra penalty/benefit formula is not encoded in current authoritative requirements, **do not invent one**. Implement the lifecycle and policy interface, and preserve current explicitly supported rule only.

Never silently treat premature closure as normal maturity.

## Concurrency

Must protect:

- payment vs premature closure
- payment vs maturity/closure
- duplicate payout
- two concurrent payout requests
- late PhonePe success after closure
- correction request involving a payment while closure is happening

Reuse production locks/transactions.

## GOLD_WEIGHT Future Proofing

Keep code boundaries for future redemption, but:

- do not enable it in Nakshathra config
- do not expose active GOLD_WEIGHT scheme creation
- do not require gold fields in CASH settlement
- do not refactor stable production redemption code unnecessarily

## Tests Required

- matured CASH enrollment becomes non-payable
- payout success
- payout in CASH/BANK/UPI as supported
- duplicate payout
- concurrent payout
- active enrollment cannot be normal-maturity-paid out early
- premature closure follows explicit policy
- payment vs closure race
- late PhonePe success after closure blocked
- closed enrollment cannot receive contribution
- payout totals match authoritative contribution/closure calculation
- financial integrity checker remains green
- no gold dependency for CASH payout

## Acceptance Gates

- settlement tests
- concurrency tests
- PhonePe late-success regression
- financial integrity suite
- typecheck
- build

## Do Not Change

Do **not**:

- invent a premature-closure penalty formula
- enable live GOLD_WEIGHT redemption
- use gold rate for cash payout
- permit duplicate settlement
- permit staff to perform owner-only payout unless explicitly authorized
- weaken settlement locks

## Completion Report

Return:

1. lifecycle states used
2. payout calculation source
3. premature closure policy boundary
4. concurrency protections
5. tests/counts
6. confirmation CASH settlement has zero gold dependency
