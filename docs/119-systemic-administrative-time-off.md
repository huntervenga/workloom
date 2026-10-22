# Administrative time-off corrections

Administrators with `leave.manage` can correct existing time-off settings and records without business-rule contradictions blocking Save. This replaces the narrow employment-date and historical-absence exceptions documented in 115–118. Security, tenant boundaries, valid input, revisions, preview freshness, idempotency and immutable history remain enforced.

## Use

Open **Time off → People & schedules**, select a person, change their dates, schedule or opening balances, then Review and Save. With **Use a custom accounting start and opening balances** OFF, accounting visibly follows employment; ON keeps the two dates independent. Existing unequal dates load ON. Current/historical material corrections need a clearly labelled reason; routine future-only changes do not gain a reason requirement merely because warnings exist.

Administrators can also edit policies, create/update/approve/reject/cancel absences, use bulk entry and append signed adjustments. Business conflicts appear as dated, typed warnings in previews and the persistent People summary. People shows only the selected person’s warnings; truncated workspace metadata uses a neutral hint instead of inventing a complete per-person count. Employee permissions and admission checks remain active. This does not add person/type reassignment or adjustment deletion; compensating adjustments remain append-only.

## Calculation and compatibility

- Approved snapshots, original versions, imported provenance and pinned overlapping charged days remain intact. New approved dates use pinned behavior. Pending requests keep their snapshot when the start stays unchanged; changing the start resolves the new start definition.
- Employment and accounting dates are independent. Openings anchor accounting; accrual requires both accounting and employment eligibility. Pinned charges outside employment still debit on/after accounting; earlier charges/adjustments remain stored but are excluded with warnings.
- Policy/type gaps earn zero new entitlement, with no invented carry expiry. Historical pools remain visible after their last policy definition is removed. Administrative new orphan requests require a trusted retained behavior snapshot; a never-known identifier remains invalid.
- Capacity/accrual pauses union overlapping intervals; paid balance debit unions each person's same-type charged date. Per-request audit/ledger history is not rewritten to manufacture credits.
- Recovered historical debt remains discoverable: bounded diagnostics retain one worst dated balance event per pool, covering openings, charges and signed adjustments. Current/projected values remain separately truthful.
- Safe bounded warnings travel in optional response metadata; strict data DTOs, mutation receipts and exact replay outcomes keep their existing shape. No post-commit warning read can turn a successful save into a failed acknowledgement.
- Heavy calculations have a controlled, localized operational query limit. The estimate covers the complete invocation and candidate batch before writes; calculations scope/index events by person. A limit error does not invent zero balances or declare the stored source invalid.

## Verification

Frozen source review and final isolated check/build passed. Focused engine/diagnostic/budget units **42/4**, new PostgreSQL **6/1**, reconciled legacy PostgreSQL **32/5**, web **48/4**, shared reason helper **5/1** and HTTP compatibility **8/1** passed. These scopes overlap and are not a new full-suite total. The unchanged legacy migration bootstrap still has the separately preserved `42703 (slug)` baseline failure; it is not reported as passing.

The final compiled private native journey **1/1** verified the 2022→2023 profile correction in both accounting modes, a mixed negative-opening/schedule edit, an administrative overlapping future record with persistent People warnings, and an ordinary invited member's conflicting rejection with no write. Four earlier harness contract/selector assumptions remain separate evidence. Root’s screenshot review then caught workspace-wide warnings under the selected person; the bounded presentation filter and two-person/truncation tests fix that real UI defect. The final native rerun additionally checks that another person’s warnings are absent. Earlier passing candidates are not added test totals.

A local read-only diagnostic exercised both actual proposed profile modes through preview and the same complete save guards using detached in-memory persistence. Each captured exactly one profile/receipt/audit operation, performed zero SQL writes and left all eight leave-table digests unchanged. No actual employee record was saved. Synthetic PostgreSQL verifies real transactional writes separately.

Operational benchmarks admitted seven people × three pools from 1900 and 100 people × 30 pools with 5,000 events, approximately 0.75s/0.93s for the scoped benchmark. Maximum-shape rejection, final aggregate bulk preflight and unrelated-heavy-person scoped saves have direct tests.

Controlled local activation was verified at **2026-10-22T07:04:28.414Z** with no DDL: all 107 tables/rows/catalog and 30 migration-ledger entries, environment, PostgreSQL and Vite were preserved; only the API restarted, worker remained OFF. All 758 served assets and both HTML entrypoints were verified with old hashed resources retained. The final independent source review passed and root inspected the scoped native screenshot. Actual employee records were not changed. Main authenticated UI, real-provider Auth, actual existing-tab interaction and production remain NOT CHECKED.

Primary implementation used subscribed Claude Opus in a curated code-only scratch; no environment files, secrets, exports or actual database records were disclosed. Two preserved runs used `claude-opus-4-5-20251101`; the first unfinished draft and second consolidated draft required manual and independent domain fixes, plus a separately owned UI/API adapter. Initial failed fixtures/checks and known migration-baseline failures remain retained as such.
