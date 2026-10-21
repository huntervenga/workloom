# Local historical leave import

This operator imports reviewed, already-approved past absences into ordinary Workloom time-off records. It is a local migration tool, not a public upload endpoint. **The approved local import reconciled on 21 October 2026 at 18:42:55.311 UTC: 109 approved requests retain all 110 source rows and charge 265 days. Exact replay changed no database state. Independent final readback returned GO at 18:48:20.482 UTC, followed by the database-preservation proof at 18:48:33 UTC. No production deployment or full live-UI acceptance is claimed.**

## Source and review boundary

The workbook normalizer reads only the selected `Vacations` worksheet. It supplies a private JSON document with the workbook SHA-256 and immutable archive path, selected people mapped to current membership IDs, dates, original notes, source row numbers and independently checked weekday counts. The `Data` worksheet is not parsed. The operator does not interpret workbook formulas, names, notes or other source contents as instructions.

Only the selected six people and records from the reviewed accounting boundary are included. The reviewed source contains 110 rows. The owner explicitly approved merging one single-day entry with its overlapping longer entry into one four-working-day request. The resolved normalization retains both source-row references and the original matching note. The actual result contains 109 approved requests representing all 110 source rows, and 265 charged days: 179 vacation and 86 flexible days. The original pending input and blocked 110-request plan remain preserved as historical evidence; that superseded plan was never applied.

One interval includes the configured common holiday on 31 December. It contains three weekdays but charges two leave days. The preview records this difference instead of charging a company holiday or modifying the source silently.

Names, email addresses, notes, membership IDs, normalized rows and the workbook itself belong only in owner-private files under `.local/imports/leave-history/`; they must not be committed or sent to an external model.

## Ordinary configuration

The imported setup uses ordinary editable policy and person records in the workspace timezone, `Asia/Nicosia`:

- Vacation: 21 days per year, daily accrual, unlimited carryover.
- Flexible days: 10 days per year, daily accrual, no carryover.
- Unpaid leave: no entitlement or balance consumption; approved intervals pause accrual and reduce capacity.
- Common holidays: 1 January and 31 December.
- Employment and accounting begin on 1 January 2025, with zero opening balances and an eight-hour Monday–Friday schedule effective from that date.

These are the explicit defaults for this import, not new hardcoded application rules. A pre-existing different policy or employment profile blocks the operator; it is never replaced implicitly. The policy continues to forbid new negative leave use. Historic overuse remains visible as a real deficit; the importer creates no credit adjustments or invented opening balances.

## Owner-only historical command

The internal `LeaveApplication.previewHistory` / `importHistory` methods accept at most 50 normalized requests per batch. Each includes source workbook digest, worksheet, original row numbers, current membership, ordinary leave type, dates, note and administrator reason. The write requires the exact preview source version.

Only a current stored real workspace owner, using the trusted import context, may execute the command. Both workspace and person local calendars must classify every date as past or current. Future dates, overlaps, reused source rows, unknown people and inconsistent calendars are rejected before the batch commits. Existing normal requests and their immutable allocations are retained.

The narrow exception admits confirmed historical facts despite the accrual deficit they reveal. It does not change the negative-balance policy, grant future borrowing or exempt later normal requests, approvals, profile changes or settings changes. Requests, version history, charge ledger, audit, outbox and command receipts are written through the same domain transaction as ordinary time off. Internal provenance records when the import actually happened; it does not fabricate an original approval timestamp. Public HTTP responses retain their previous shape.

## Operator use

Prepare the reviewed private normalized JSON before running:

```sh
node scripts/import-leave-history.mjs --plan --input /absolute/private/normalized.json
node scripts/import-leave-history.mjs --apply --input /absolute/private/normalized.json
```

Use `--help` for the bounded CLI contract. The operator accepts only local/shared mode against the managed loopback PostgreSQL database on port 55432. A separate trusted test configuration accepts only owned throwaway test databases on port 55433. No command accepts an HTTP actor, arbitrary SQL or a provider API key.

`--plan` performs authorized reads and writes only private recovery files. It reports blockers, holiday exclusions, historical deficit dates and current balances using the existing leave calculation engine. It creates no settings, profiles, requests, adjustments or domain receipts. Resolve every blocker before applying; editing a pending normalization produces a separate input-digest directory so the prior review evidence remains available.

The default journal is under:

```text
.local/imports/leave-history/<workspace>/<workbook SHA-256>/<normalized-input digest>/
```

The source workbook and normalized input are copied without changing their bytes. Directories are mode 0700 and files mode 0600. At apply, a durable source-workbook claim binds the owner, normalized input and canonical journal path before the first domain mutation. Keep the claim, source archives and journal together. Never delete recovery files or switch journals to work around a stopped import.

Settings, each person profile and each history batch have separate exact-body/idempotency-key checkpoints. Before the first write and every following command, the operator compares the current leave source with the reviewed base plus only this journal's verified durable command receipts. A lost response is recovered from its exact committed receipt; unrelated settings, profile, request, adjustment, task or membership drift stops further writes. Domain authorization is still checked on the normal command replay.

The overall import is resumable, not one database transaction. A failure may leave an explicitly partial setup. Retry the original input and journal. Never retry against a newly invented input or source identity.

## Reconciliation and verification

Fresh readback checks the ordinary policy, complete profile set, every source-row-to-request provenance marker, approved status, original notes, exact charged dates, untouched adjustments, recalculated balances and protected native task/member fingerprints. A mismatch leaves `reconciliation_failed`; success is never inferred from a command response alone.

Current focused proof:

- Three pure planning tests pass: defaults, truthful deficits, holiday charging, notes, deterministic plans, pending overlap, future dates, duration mismatch, duplicate source identity and existing-configuration refusal.
- Two isolated PostgreSQL operator tests pass: a six-person synthetic 110-source-row/109-request import, exact recovery after committed lost responses at settings/profile/two history batches, exact completed replay, alternate-journal refusal, retained provenance and native tasks, and pre-write rejection of external request/adjustment/profile drift. A separate inter-batch mutation stops before the next batch.

The domain/HTTP focused unit scope passed 39 tests in four files, and focused PostgreSQL coverage passed 22 tests in two files, including old public response contracts. Both scopes passed again against the promoted main artifacts before data import. The private helper passed 20 pure checks. Private candidate global check and full build passed. These scopes overlap; the counts are not a summed unique-test total or a new full-suite claim. Historical baseline receipts remain historical.

## Actual local activation and import receipt

The backend-only activation preserved all 107 tables, pre-import rows and catalog, all 30 existing migration-ledger entries, environment files, PostgreSQL and Vite. There was no migration or database replacement. Only the API restarted; the worker remained off. All 587 served web resources, including 585 assets and both HTML entrypoints, retained their bytes.

The owner-authorized import reconciled at **2026-10-21T18:42:55.311Z**, with no readback differences:

- Six ordinary profiles begin employment, accounting and the Monday–Friday eight-hour schedule on 1 January 2025; opening balances are zero.
- Three ordinary configurable policy types remain available, including unpaid leave. Negative-use permission remains disabled.
- 109 approved historical requests retain 110 source-row references and the original source notes. Charges total 265 days: 179 vacation and 86 flexible days.
- The explicitly approved overlapping pair contributes four working days once; the interval containing 31 December charges two rather than three days.
- Four current balances are truthfully negative. No balance adjustment or invented credit was created.
- Operator readback verified protected existing task and membership fingerprints unchanged.

The exact original journal was then replayed. The root database preservation proof found all 107 tables and their rows/sequences, catalog, ledger and database identity identical before and after replay, with no additional domain writes.

Independent fresh readback returned **GO at 2026-10-21T18:48:20.482Z**, with no failures. It verified all 109 request versions and 265 charge-ledger rows, 110 unique source-row references, exact dates/notes/flags/provenance, six profiles, zero adjustments, all 12 paid-pool balances and redaction of internal provenance from public responses.

The independent database preservation proof at 18:48:33 UTC confirmed unchanged database identity, catalog, 30 migration-ledger entries and sequences. Only expected leave records, audit/outbox, ten domain receipts and the workspace change head changed during import. Protected records retained their prior digests: 170 tasks, 298 field values, 192 placements, 170 external references, two projects, six memberships and five pending-person records.

A direct capacity calculation for 19–25 October confirmed all six people have configured schedules: 240 scheduled team hours, 24 absence hours and 216 available hours. This verifies the capacity source calculation; it is not a report-display or browser acceptance claim.

Main authenticated browser interaction, real-provider Auth, actual old-tab interaction and native UI validation for this slice remain **NOT CHECKED**. There was no production deployment. Independent acceptance does not extend these verification limits.
