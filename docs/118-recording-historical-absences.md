# Recording historical absences

Administrators can review and record actual past absences, including long unpaid periods, without changing leave policy or fabricating opening credits.

## Use

1. Open **Time off → Request time off**, select the person/type and enter the real dates.
2. Choose **Review charge**. A reason is not needed for this read-only calculation.
3. Review the working-day charge, before/after balances and dated warnings. Enter a reason, then submit.

Dates that have started or are in the past visibly require a reason to save. Attempting to submit without one focuses an adjacent field error. Entering only a reason reuses the reviewed calculation; saving still checks its source version. Bulk entry follows the same rule for every selected person's local date.

For a manager's fully elapsed range, saving records approved history in one command. First approval of an existing fully elapsed pending request and bulk historical assignment use the same bounded admission path. Both past endpoints are checked against the person's trusted local date; a pending approval must retain its person, type and dates. Existing fully elapsed approved date corrections retain the rules in [117](117-historical-absence-corrections.md).

Paid-pool debt, including debt exposed by unpaid accrual pauses, remains visible as advisory information for these reasoned historical records. This does not approve ordinary current/future leave, waive employee permissions, change policy or add credits. The negative-approval flag is preserved from the pending request or stays false. Date bounds, employment/accounting boundaries, type consistency, overlap, revisions, source freshness and exact idempotent retry remain enforced. History is audited with its reason and dates; old versions and charge rows remain immutable.

## Cause and evidence

The reported failure happened at **Review**: the previous preview required a retrospective reason before calculating charges. An isolated baseline reproduction confirmed that exact rejection and zero database writes. The reported interval fits the existing range limit; no limit was increased.

- Private full build and final full static check: **PASS**.
- Shared classifier tests: **13/1 PASS**; PostgreSQL tests: **3/1 PASS**.
- Focused form/editor/page tests: **49/3 PASS**; final form/bulk/unpaid subset: **10/1 PASS** (overlapping coverage).
- PostgreSQL proof includes a 335-calendar-day unpaid interval, 240 scheduled weekdays, zero balance-day debit, paid-pool debt, no-reason preview conservation, required save reason, historical bulk/pending admission, preserved negative-approval state, old facts, audit/replay and ordinary-policy rejection paths.

Claude Opus was the primary implementer through the subscribed CLI: actual model `claude-opus-4-5-20251101`, 44 turns / 374 seconds, with 21 curated code/synthetic-test files. No secrets, exports or database contents were shared. Manual review consolidated the trusted save path, added pending/bulk consistency, preserved balance comparisons and negative-approval state, and corrected synthetic fixtures. Earlier failing fixture/static logs remain preserved separately from final proof.

Private compiled-browser verification: **1/1 PASS**, using only a synthetic owned database and the exact 1 May 2025–1 April 2026 range (336 inclusive calendar dates). Empty-reason review returned 200; attempting to save without a reason focused the field and wrote nothing. Entering a reason produced one approved history record, with 0 balance days / 1,920 working hours unavailable, and reset the form. The private API stopped and its child database was dropped. Initial harness environment/locator failures were retained before the final pass.

Independent source review: **GO**. The pending historical approval branch has domain coverage, but no dedicated UI submission test; ordinary approval has existing UI coverage. Controlled local activation passed: API-only restart, no DDL, all 107 tables/rows/catalog, 30 migration-ledger entries and environment preserved. PostgreSQL/Vite stayed unchanged and worker OFF; 733 assets/two HTML responses were verified with old assets retained. The first activation attempt refused before any runtime change because acceptance metadata overwrote the boolean review gate with a descriptive string; correcting the metadata allowed a verified retry. This was a preflight refusal, not a product-code failure. Actual user records have not been changed. Main authenticated UI, real-provider Auth, existing tabs and production are not verified by this slice.
