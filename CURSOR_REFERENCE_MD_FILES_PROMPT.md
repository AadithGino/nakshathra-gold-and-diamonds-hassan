# Cursor Prompt — Use the Attached Phase MD Files as the Authoritative Conversion Specification

You have the Kairali production backend, the Nakshathra demo/reference backend, and a set of Nakshathra conversion `.md` files in this workspace.

Treat the `.md` phase files as the **authoritative implementation specification**.

## Read These Files First

Read in this exact order:

1. `01_PHASE_1_DOMAIN_CONFIG_CONVERSION.md`
2. `02_PHASE_2_NAKSHATHRA_SCHEME_ENGINE.md`
3. `03_PHASE_3_CUSTOMER_ENROLLMENT_CONVERSION.md`
4. `04_PHASE_4_STAFF_PORTAL_COLLECTIONS.md`
5. `05_PHASE_5_STAFF_PHONEPE_CASH_CORRECTIONS.md`
6. `06_PHASE_6_CASH_SETTLEMENT_PREMATURE_CLOSURE.md`
7. `07_PHASE_7_ADMIN_REPORTING_MIGRATIONS_DOCS.md`
8. `08_PHASE_8_FINAL_PRODUCTION_VERIFICATION.md`

Also read `CURSOR_MASTER_PHASE_EXECUTION_PROMPT.md`.

## Repository Authority

- Kairali production backend = implementation source of truth for engineering quality and financial safety.
- Nakshathra demo backend = business-flow reference only.
- Phase MD files = source of truth for the conversion requirements.
- If the demo conflicts with the MD files, follow the MD files.
- If the Kairali implementation already provides a safer equivalent mechanism than the demo, keep the Kairali mechanism and adapt its business policy.

## Before Each Phase

For the active phase:

1. read the complete phase MD
2. inspect every relevant current source file listed or implied by that phase
3. map existing reusable production code
4. identify migrations/index changes
5. only then edit

Do not guess file names before inspection.

## Strict Scope

Work on ONE phase at a time.

Do not start the next phase until:

- required code is written
- modified files are read back/verified
- phase tests pass
- typecheck/build gates required by the phase pass
- completion report is produced

Do not make unrelated refactors.

## Core Rules

- CASH is the only live Nakshathra scheme type.
- GOLD_WEIGHT stays dormant for future support.
- 11-month scheme.
- months 1-6 flexible, unlimited number of payments.
- months 7-11 capped.
- monthly cap strategy = first-six successful contribution total divided by first-six successful payment count.
- do not copy demo's accidental `/6` or 11-flexible-month behavior.
- server is authoritative for scheme month/cap.
- Asia/Kolkata everywhere financial day/month boundaries matter.
- integer paise arithmetic only.
- use DB transactions/locks/indexes for concurrency guarantees.
- preserve Kairali PhonePe hardening.
- preserve audit trail.
- staff financial corrections use request/approval/reversal/replacement, never silent mutation.
- CASH maturity/premature closure settles through payout, not gold redemption.
- do not introduce unnecessary enterprise infrastructure.

## Production Fixes That Must Survive

Do not regress:

- atomic failed-login lockout
- strict phone validation without truncation
- escaped user search regex
- strict gateway integer-money parsing
- IST financial reporting
- valid accounting period month checking

## Required Completion Report Per Phase

Return:

### Phase
`Phase N — <name>`

### Result
`PASS / BLOCKED`

### Files Changed
List exact files.

### Business Rules Implemented
List only rules from this phase.

### Migrations / Indexes
List exact additions/changes.

### Tests
Show commands and exact passed/failed counts.

### Build Gates
Typecheck/build/index verification status as applicable.

### Scope Check
Confirm no unrelated phase or demo-code replacement occurred.

### Blockers
List any remaining blocker.

If blocked, stop. Do not work around a P0/P1 failure by weakening tests or business rules.

Begin with Phase 1.
