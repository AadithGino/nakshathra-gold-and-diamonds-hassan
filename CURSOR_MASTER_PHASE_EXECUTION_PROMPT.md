# Cursor Master Prompt — Execute Nakshathra Conversion Phase by Phase

You are converting an already audited, production-hardened Kairali jewellery backend into the production Nakshathra Jewellers backend.

## Source Repositories

You will have two codebases in the workspace:

1. **Kairali production backend**
   - This is the ONLY implementation base.
   - Preserve its financial hardening, idempotency, concurrency controls, PhonePe verification, settlement protection, migrations, indexes, integrity checks, authentication hardening, and backup architecture.

2. **Nakshathra demo backend**
   - This is READ-ONLY BUSINESS-LOGIC REFERENCE.
   - Use it to understand Nakshathra customer/staff workflows and the intended 6+5 scheme model.
   - Do NOT replace the Kairali implementation with demo code.
   - Do NOT copy weaker demo implementations over hardened production code.
   - Do NOT modify the demo backend.

## Phase Files

Execute these files strictly in order:

1. `01_PHASE_1_DOMAIN_CONFIG_CONVERSION.md`
2. `02_PHASE_2_NAKSHATHRA_SCHEME_ENGINE.md`
3. `03_PHASE_3_CUSTOMER_ENROLLMENT_CONVERSION.md`
4. `04_PHASE_4_STAFF_PORTAL_COLLECTIONS.md`
5. `05_PHASE_5_STAFF_PHONEPE_CASH_CORRECTIONS.md`
6. `06_PHASE_6_CASH_SETTLEMENT_PREMATURE_CLOSURE.md`
7. `07_PHASE_7_ADMIN_REPORTING_MIGRATIONS_DOCS.md`
8. `08_PHASE_8_FINAL_PRODUCTION_VERIFICATION.md`

## Mandatory Execution Rules

- Read the current phase file completely before editing.
- Inspect existing implementation before creating new abstractions.
- Reuse production services whenever they already solve the problem safely.
- Do not implement future phases early unless a tiny compile-only dependency is unavoidable.
- If a future-phase dependency is unavoidable, keep it minimal and explicitly report it.
- Never silently change business rules.
- Never change the cap formula to `total / 6`.
- Current live scheme is CASH only.
- GOLD_WEIGHT remains future-proof/dormant.
- Asia/Kolkata is the business timezone.
- Financial money arithmetic is integer paise.
- Mobile clients are not authoritative for cap/month calculations.
- Staff cannot directly mutate posted financial records.
- Every financial posting must remain idempotent and concurrency safe.
- Do not weaken PhonePe finalization/reconciliation.
- Do not remove critical financial indexes.
- Do not bypass transactions for convenience.
- Do not add Redis, queues, microservices, multi-tenant frameworks, maker/checker, or other enterprise features not required for ~500 customers / one owner.
- Preserve the existing targeted production fixes: atomic failed-login lockout, strict phone normalization, escaped regex search, strict integer money parsing, financial-report timezone correctness and accounting-month validation.

## Phase Gate Rule

After each phase:

1. run the exact tests required by the phase file
2. run typecheck/build where required
3. report exact test counts
4. list files changed
5. list migrations/indexes
6. state any blocker
7. confirm the phase's “Do Not Change” rules were respected

Do NOT move to the next phase if the current phase has an unresolved P0/P1 code defect.

If a test failure is clearly pre-existing or environment-only, prove that with evidence and report it explicitly rather than hiding it.

## Git Discipline

Prefer one intentional commit per completed phase if the repository/workflow permits.

Suggested commit style:

- `phase1: enable nakshathra domain and staff foundation`
- `phase2: implement nakshathra 6+5 contribution engine`
- etc.

Do not mix unrelated cleanup into phase commits.

## Business Rules That Override Demo Drift

The demo backend contains conflicting newer code that can force 11 fully flexible months. Ignore that drift.

Authoritative rule:

- 11 months total
- months 1-6 flexible/unlimited multiple payments
- months 7-11 capped
- capped monthly limit = total successful amount in months 1-6 / number of successful payments in months 1-6
- multiple payments remain allowed in capped months until combined monthly total reaches cap
- CASH scheme only today
- payout for CASH settlement
- GOLD_WEIGHT retained for future only

## Final Deliverable

At the end of Phase 8 provide:

- final production audit
- code-ready verdict
- production-ready verdict
- test/build results
- migration/index verification results
- financial integrity result
- PhonePe verification status
- backup/restore status
- list of any remaining non-blocking issues
- final changed-file summary

Start with Phase 1 only. Do not implement all phases in one uncontrolled pass.
