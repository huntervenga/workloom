# Person time-off history

## Where to find it

Open **Time off → People & schedules** and choose a person.
Their **Time off history** appears after the balance cards and before employment/schedule settings.
It includes all recorded dates and statuses, rather than only the calendar’s current month.
Each entry shows its configured leave type and color, inclusive dates, recorded balance charge and note.
Vacation, flexible and unpaid types use the same history and existing policy configuration.
A zero recorded balance charge is valid for unpaid leave; it is not a claim that no workdays were missed.

## Review and correct an entry

Open an entry to use the same editor as Calendar.
Change dates or the note, supply the required correction reason, then choose **Review charge** and **Save request changes**.
The server preview remains authoritative for charges, balances and policy validation.
Owner/admin permissions and existing employee past-day/future-tail restrictions remain unchanged.
Approval, rejection and cancellation retain their existing rules and domain commands.
The UI introduces no new write endpoint, exception or audit bypass.

While a request draft is unsaved, the person picker, view tabs and new-request action are disabled.
A visible hint explains why. **Discard local changes** restores the current saved entry and unlocks navigation.
Confirmed saves clear only the affected draft and retain the confirmed revision while overview reads catch up.
A background revision does not discard an unsent edit; the existing **Load latest** action remains available.
A single history list serves Calendar and People. Person filtering happens after confirmed acknowledgements merge; other people’s records/editors are absent from the person history DOM.

## Verification checkpoint

The isolated candidate passed 24 focused web tests across the history and page suites, focused lint, web typecheck and localization validation.
Tests cover all leave types, selected-person/acknowledgement filtering, empty history, employee locks, dirty navigation/discard, remote revisions, repeated owner corrections, charge review and overview/capacity refresh.
The isolated web build passed; existing large-chunk build warnings remain.
These are focused results, not a claim that the entire product suite was rerun.
Private compiled browser acceptance passed **1/1 on 21 October 2026**, covering selected-person filtering, date/note/reason correction, authoritative charge preview, balance change from two to three days, and dirty-draft discard/navigation. The root reviewed the 1440-pixel light and 1280-pixel dark screenshots for readability.
Three earlier private-harness failures—base URL environment setup, details locator and exact end-date label—were corrected; their logs remain preserved. They are not production-flow acceptance claims. Independent source review passed.

This slice changes frontend source only. No backend, API, contracts, migration or local leave data was changed by implementation/testing.
Implementation and private testing did not edit main history or balances.

## Controlled local web activation

Root activated the compiled web candidate on 21 October 2026 with no service restart; the worker remained off.
The first activation guard safely refused its stale 137-request/six-profile assumption after concurrent user changes. The corrected guard preserved the fresh live state of **138 requests and seven profiles**.
All 107 tables and their rows/catalog, 30 migration-ledger entries, 397 backend sources, 1,136 backend artifacts, environment files and process identities were unchanged through activation.
HTTP verification passed for **610 assets and both HTML entrypoints**; old hashed resources were retained for existing tabs. This is resource compatibility proof, not authenticated old-tab interaction acceptance.
Main authenticated browser interaction, real-provider Auth, actual old tabs and production remain **NOT CHECKED**. The native acceptance above used a private compiled fixture, not main data or the real identity provider.
