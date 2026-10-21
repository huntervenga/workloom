# Earlier leave history: local 2022–2024 append

This records a local data import, not a product release or production deployment.
The [initial 2025–2026 import](112-local-leave-history-import.md) remains its own historical receipt.

## Owner decision and resulting configuration

The owner explicitly requested temporary employment and accounting starts of **1 January 2022** for all six mapped people, with balances recalculated; the real dates will be reviewed later.
Opening balances remain zero. No synthetic credits, adjustments or negative-use permission were added.

Ordinary settings and profile commands prepend the 2022 policy and eight-hour Monday–Friday schedule.
The original 2025 policy snapshot and schedule periods remain intact, using the same policy type identities.
The configurable vacation entitlement remains 21 days annually with unlimited carry; flexible days remain 10 annually without carry, and unpaid leave remains available.
The six profiles now use 2022 employment/accounting starts instead of the initial import’s 2025 starts.

A later correction must satisfy the ordinary history invariant: employment/accounting cannot move after an existing approved absence that would then become invalid.
Do not promise arbitrary replacement dates. An earlier employment date with a deliberate accounting boundary and opening balances may be appropriate when the real records are reviewed.

## Source and normalization

Only the selected six people’s **Vacations** sheet rows were included; the workbook’s Data sheet was not imported.
The immutable workbook digest and original completed import claim/journal were retained.
The append uses a separate claim bound to the new row set; it does not rebind or overwrite the original import.

| Year | New requests/source rows | Working days charged |
| --- | ---: | ---: |
| 2022 | 2 | 4 |
| 2023 | 5 | 5 |
| 2024 | 21 | 63 |
| Total | 28 | 72 |

All 28 rows are vacation. Dates are inclusive; only scheduled working days charge the balance.
Two source rows, **4 and 11**, contain cached durations of five days although their intervals contain three working days. Each charges **three**, preserving the warning and original dates/notes in private evidence.
No overlaps or duplicate source rows were found against the initial import.

## Actual local result

Root apply reconciled at **2026-10-21T19:31:00.907Z** with **zero differences**: 28 additional approved requests and 72 charged vacation days.
Combined history contains **137 requests, 138 unique source-row references and 337 charged days**.
The initial 109 requests and their 265 charged days remain retained, with their versions and original charge allocations protected.
This append changes ordinary leave settings/profiles/history through existing domain commands; no migration, application source change, build or runtime restart was needed.

The first real plan stopped before any domain write because an older protected-row fingerprint used the database’s Asia/Nicosia timestamp rendering while the append used UTC. A full 107-table comparison confirmed no data change.
The private correction validates the completed parent’s exact receipt-derived leave state, versions and allocations, then captures fresh UTC protected fingerprints for the extension. Drift after that new plan still blocks before the next command.
Focused checks passed **4/4**: one pure test and three isolated PostgreSQL tests, including Nicosia/UTC compatibility, legitimate native edits before planning, rejection of edits after planning, lost-response recovery, exact retry and parent-artifact preservation.
The initial passing test log and failed-plan diagnostic remain preserved as historical private evidence.

Exact main replay passed: all 107 tables and their rows, catalog, sequences, migration ledger and database identity were identical before and after replay, with no additional domain writes. Compiled artifacts, environment files and process state also match the pre-extension capture.
Independent fresh readback returned **GO at 2026-10-21T19:36:27Z**: all 137 request versions, 138 unique source rows, old 265 plus new 72 charge allocations, both settings versions, all 12 profile versions and 12 balances matched exactly. Current-week available capacity remains 216 team hours. Source bytes and parent plan/journal/claim hashes were exact.
The 107-table comparison preserved catalog, 30 migration-ledger entries, sequences, database identity and company-address state; 95 tables retained their exact row fingerprints. Expected changes were leave records, audit/outbox, eight receipts and the workspace head. Separately, an existing Auth session refreshed in the background after import, retaining the same two session rows; this is not an importer write. The exact root replay itself changed no table.
Main authenticated browser, real-provider Auth, actual old tabs, native UI and production remain **NOT CHECKED** for this append.
