# Nakshathra Cursor Conversion Prompt Kit

This folder contains the full phase-locked prompt set for converting the audited Kairali production backend into the Nakshathra Jewellers backend while using the Nakshathra demo backend only as a business-logic reference.

## Files

- `01_PHASE_1_DOMAIN_CONFIG_CONVERSION.md`
- `02_PHASE_2_NAKSHATHRA_SCHEME_ENGINE.md`
- `03_PHASE_3_CUSTOMER_ENROLLMENT_CONVERSION.md`
- `04_PHASE_4_STAFF_PORTAL_COLLECTIONS.md`
- `05_PHASE_5_STAFF_PHONEPE_CASH_CORRECTIONS.md`
- `06_PHASE_6_CASH_SETTLEMENT_PREMATURE_CLOSURE.md`
- `07_PHASE_7_ADMIN_REPORTING_MIGRATIONS_DOCS.md`
- `08_PHASE_8_FINAL_PRODUCTION_VERIFICATION.md`
- `CURSOR_MASTER_PHASE_EXECUTION_PROMPT.md`
- `CURSOR_REFERENCE_MD_FILES_PROMPT.md`

## Recommended Use

1. Put the Kairali production backend, Nakshathra demo backend, and this prompt folder into the same Cursor workspace.
2. Make the Nakshathra demo folder read-only if practical.
3. Give Cursor `CURSOR_MASTER_PHASE_EXECUTION_PROMPT.md`.
4. Tell it to execute Phase 1 only.
5. Review Phase 1 output and tests before letting it continue.
6. Repeat phase-by-phase.
7. Use `CURSOR_REFERENCE_MD_FILES_PROMPT.md` when you want Cursor to explicitly re-ground itself in all phase files.

Do not ask Cursor to “just convert everything” without the phase gates; the financial and concurrency rules are intentionally locked by phase.
