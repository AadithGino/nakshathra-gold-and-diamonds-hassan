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

# Phase 2 — Nakshathra 6+5 Scheme Engine

## Objective

Implement the authoritative Nakshathra 11-month CASH contribution policy on top of the production financial core.

This is the central business-rule phase.

## Inspect Before Editing

Read:

- scheme plan model/service/controller
- enrollment model/service
- payment model/service
- payment eligibility/guard services
- date/month utilities
- transaction/idempotency helpers
- payment reversal semantics
- indexes for active enrollment and payments
- Nakshathra demo's 6+5 calculation code as reference only
- all Kairali tests involving payment windows, maturity, scheme month, concurrency and late provider success

## Data Model Requirements

Scheme plan must support or snapshot equivalent fields:

- `schemeType`
- `durationMonths`
- `flexibleMonths`
- `cappedMonths`
- `minimumPayment`
- `capStrategy`
- contribution-policy version
- settlement-policy version if already modeled

Nakshathra live configuration:

- `schemeType = CASH`
- `durationMonths = 11`
- `flexibleMonths = 6`
- `cappedMonths = 5`
- `capStrategy = AVERAGE_SUCCESSFUL_PAYMENT_FIRST_6` or a comparably explicit enum/name

Enrollment must snapshot these rules.

## Scheme-Month Calculation

Implement one authoritative utility/service.

Requirements:

- timezone: Asia/Kolkata
- calendar-month semantics
- deterministic boundaries
- month 1 through month 11 only
- reject before enrollment start
- reject after contribution period
- maturity handled separately
- do not duplicate this math in controllers or UIs

## Flexible Phase Rules — Months 1-6

Allow:

- multiple successful payments in the same month
- arbitrary different amounts
- no monthly cap

Still enforce:

- minimum payment
- enrollment is payable
- scheme is within valid contribution period
- idempotency
- correct actor/ownership
- successful transaction semantics
- no payment after payout/closure

## Capped Phase Rules — Months 7-11

Monthly cap formula:

`total successful amount contributed in scheme months 1-6 / number of successful payments in scheme months 1-6`

Rules:

- count only financially valid successful payments.
- reversed/void/failed/pending payments do not count.
- zero successful payments in first six months must produce a deterministic non-payable state or business-rule error; never NaN/Infinity.
- multiple payments within a capped month are allowed.
- sum of successful payments for that scheme month plus requested amount must be <= monthly cap.
- exact-cap payment is allowed.
- 1 paise beyond cap is rejected.
- money arithmetic is integer paise only.
- preserve strict gateway money parsing already added to production base.

## Concurrency Requirement — P1

Two concurrent valid-looking payments must not together exceed a capped month's allowance.

Implement using the production transaction/locking/idempotency architecture, not an application-only pre-check.

The final committed financial state must enforce the cap.

## Payment Preview API

Create or adapt a backend-authoritative preview endpoint.

Return at minimum:

- enrollment id
- scheme month
- phase: FLEXIBLE | CAPPED | NOT_PAYABLE
- requested amount in paise
- allowed
- minimum payment
- monthly cap when applicable
- already paid this scheme month
- remaining amount this scheme month
- reason code/message when rejected

Preview is informational only. Final payment posting must independently revalidate all rules transactionally.

## CASH-Scheme Behavior

For current Nakshathra CASH enrollments:

- do not fetch or require gold rate.
- do not generate gold grams.
- gold-related payment snapshots must be null/absent according to existing schema contract.
- financial totals remain rupee/paise based.

## Indexes

Add/verify indexes necessary for:

- enrollment + scheme-month successful contribution lookup
- active enrollment uniqueness if one-active-scheme rule remains
- transactional cap checks
- payment status queries

Do not create redundant high-cardinality indexes without reason.

## Tests Required

### Scheme Month

- exact start boundary
- end-of-month boundary
- IST midnight boundary
- month 1
- month 6
- transition 6 -> 7
- month 11
- after contribution end

### Flexible

- multiple payments same month pass
- different amounts pass
- no cap is applied
- minimum payment still enforced

### Cap Formula

- correct amount/count arithmetic
- failed payment excluded
- reversed payment excluded
- duplicate/idempotent attempt excluded
- zero-payment denominator safe
- paise precision exact

### Capped Months

- below cap pass
- exactly cap pass
- over by 1 paise reject
- multiple payments accumulating to cap pass
- next capped month starts its own monthly usage bucket

### Concurrency

- simultaneous payments that would jointly exceed cap: only safe committed total survives
- duplicate idempotency key
- different idempotency keys
- payment vs closure race
- late PhonePe success after non-payable state remains protected

## Acceptance Gates

- targeted scheme/payment unit tests
- concurrency tests
- full payment-related regression suite
- typecheck
- build
- index verification test
- no gold-rate dependency in CASH payment path

## Do Not Change

Do **not**:

- implement staff UI/dashboard features
- implement correction requests
- implement cash handover
- redesign auth
- implement future GOLD_WEIGHT redemption
- copy the demo's `total / 6` cap
- allow controllers/mobile apps to bypass service-level validation
- weaken existing PhonePe verification/idempotency/settlement protections

## Completion Report

Return:

1. exact cap strategy implemented
2. scheme-month definition
3. files changed
4. indexes/migrations
5. concurrency mechanism used
6. tests and counts
7. confirmation CASH path has no gold dependency
8. confirmation demo's accidental 11-flexible-month logic was not copied
