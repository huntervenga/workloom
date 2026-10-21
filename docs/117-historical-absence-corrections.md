# Correcting historical absences

An administrator can correct the dates of an approved, fully elapsed absence without changing leave policy or inventing balance credits.

## Use

1. Open **Time off → People & schedules**, select the person and expand their history entry.
2. Correct the dates, enter a reason, and choose **Review charge**.
3. Review working-day charges and dated balance warnings, then choose **Save request changes**.

Both the original and corrected end dates must be strictly before the person's current local date. The existing and proposed request must be approved, its dates must actually change, and the current actor must have leave-management permission with a nonempty reason. The service derives this classification from trusted state; there is no caller-controlled bypass option.

For this exact correction, past, current and already-booked future deficits are advisory. This includes paid leave and historical unpaid periods that pause accrual. New requests, pending approvals, ongoing absences and extensions into today or the future retain ordinary balance checks. Invalid ranges, overlaps and incompatible leave types still fail.

Saving creates a new audited revision with the reason and old/new dates. Old versions and ledger entries remain immutable; overlapping charged days stay pinned and added days are calculated normally. Imported provenance and the existing negative-approval flag are preserved. Source-version, revision, authorization and idempotency checks remain active. Further ordinary leave uses the resulting actual balance.

## Verification

- Full isolated lint, localization, boundaries, typecheck and build: **PASS**.
- Shared eligibility tests: **10/1 PASS**; synthetic PostgreSQL tests: **3/1 PASS**.
- Focused request/page/editor UI tests: **49/3 PASS**; final warning-copy subset: **18/1 PASS** (overlaps the 49).
- PostgreSQL proofs cover paid historical/current/future debt, unpaid accrual debt, pinned charges, provenance, audit, replay and retained rejection paths. The future-reservation fixture finds its boundary through ordinary previews rather than assuming a month.
- Initial synthetic-fixture errors and an isolated-stage missing worker workspace link were corrected; earlier logs were retained. Final gates apply to the frozen candidate.
- The targeted real edit was checked read-only: eligible, source valid and no overlap. The record was **not saved**.

Claude Opus was the primary implementer through the subscribed CLI, actual model `claude-opus-4-5-20251101`, 34 turns / 312 seconds. Its context contained 18 curated code/synthetic-test files, with no secrets, exports or database contents. Manual review corrected advisory placement, strengthened fixtures/copy assertions and preserved ordinary audit shape. Private source hashes and verification logs bind the final candidate.

Controlled local activation passed: API-only restart, no DDL, all 107 tables/rows/catalog, 30 migration-ledger entries and environment preserved. PostgreSQL and Vite remained unchanged, worker OFF; 709 assets and two HTML responses were verified with old resources retained. Actual user records were unchanged. Native browser, main authenticated flows, existing tabs and production deployment have not been verified by this slice.
