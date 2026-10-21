# Time-off request save feedback

Open **Time off → People & schedules**, choose a person and expand the relevant history entry.
Edit its dates or note, enter a correction reason when required, select **Review charge**, then **Save request changes**.
A rejected save keeps the draft and shows an inline error beside that editor; the feedback scrolls into view and receives focus.
Safe error text includes a request ID when the API supplies one, so it can be shared for diagnosis.
The page-level error remains as an intentional fallback alongside inline feedback.

For changed server revisions, refresh the current record before continuing; for stale source data, refresh the preview and review it again.
An uncertain network result offers **Retry exact submission**, preserving the original command and idempotency key rather than creating another write.
Known errors can be dismissed; editing also clears their obsolete feedback. Uncertain submissions retain their dedicated recovery path.
**Discard local changes** remains available for an editable draft. A successful acknowledgement updates the editor revision and clears its saved draft.

**Balance details for these dates** expands preview conflicts with dates, leave types and signed balances.
These are preview context, not proof that every rejected save was caused by a deficit.
Ordinary approval, historical-reason, source-version and negative-balance rules are unchanged.

## Diagnosis and verification

The investigated sequence returned HTTP 200 first and HTTP 422 on the next attempted save; the failure was not visible beside the editor.
The pictured 26–30 October interval contains three working days. A one-day reduction calculated correctly; no backend repeat-save defect was established.
No actual leave records were modified during diagnosis or this implementation.

Claude contributed two subscription-based, code-only rounds using actual model `claude-opus-4-5-20251101`, followed by manual adjustments and independent review.
No environment files, secrets or database contents were sent. Private provenance SHA-256: `686bc2b64c69633def110a731f85e0258ada000283698445a0edf9928faa1653`.
The final frontend passed **38 focused tests in two files**, scoped lint/localization and an isolated web build including TypeScript; independent source review passed.
No new backend, PostgreSQL, full-suite or native-browser pass is claimed.
Controlled local web-only activation preserved all 107 tables/rows/catalog, all 30 migration-ledger entries, live 138 requests/seven profiles, environment files, backend artifacts and process identities.
There was no DDL or restart. Verification covered **685 assets and both HTML entrypoints**, retaining old hashed resources.
Main authenticated UI, real-provider Auth, actual old-tab interaction, native UI and production remain **NOT CHECKED**.
The preceding [employment-date correction checkpoint](115-employment-date-corrections.md) retains its own verification scope.
