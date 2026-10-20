# Table summaries, section widgets and field controls

Historical accepted slice, superseded locally by [100: configurable planning checks](100-configurable-planning-checks.md), product `98a6d24`. Its original G proofs below remain unchanged.

**ACCEPTED AND ACTIVATED LOCALLY.** Product `b0efabd` (`b0efabd5cf2f1bb90abf44cfee2a38cb6cb9e162`), final Candidate G: 1,508 source files / 1,095 compiled files. Source SHA-256 `188146e1dc96444517b14f8448c44e90cbb3fc2e82ca314ae756378f1947ea5f`; build manifest SHA-256 `7266a2bb5c4ce6e1ea10207ed16cc04df3e7950764a0eefae3c9188dc7de66ab`. Controlled local activation completed **20 October 2026, 10:15:28 Asia/Nicosia** (`2026-10-20T07:15:28.884Z`). This document is a documentation-only follow-up to the frozen, verified product snapshot. The previous accepted slice is [98](98-project-and-workspace-manager-reports.md).

Open the [demo project](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d), or [workspace Reports](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/reports). These are user entry links, not evidence of a newly checked main authenticated session.

## Quick start

Open a project’s Tasks tab. At the bottom of a numeric or duration column, click **Calculate** and choose **Sum**, **Average**, **Minimum**, **Maximum** or **Count filled values**. **None** removes that calculation. Existing configurations with multiple operations show each separately; changing or removing one preserves the others. The advanced totals editor also supports **Count tasks** and several selected calculations. Footer and group figures describe the full table and corresponding section/assignee scope.

These shared PostgreSQL preferences are editable by owners/administrators and visible to readers. Server totals include matching tasks not loaded in the browser. Expanding rows cannot increase them. Search, participant, individual-status and archived filters currently make these table totals unavailable; the interface explains that restriction rather than showing a misleading subtotal.

**Count filled values** counts known numeric/duration values, including zero, while excluding missing and cleared values. **Count tasks** counts canonical tasks independently of their metrics. Sum, Average, Minimum and Maximum remain unknown when no known metric exists. Duration values use stored minutes and the existing hours/minutes display. Exact decimal calculations include negatives and remain independent of display rounding. Plan and Fact remain ordinary custom fields.

Use the column chevron → **Edit field** → **Options** to add, rename, edit or archive select variants and change their **Color**.

## Group summaries and working time

Use the settings control beside a section or assignee heading to configure up to four compact summaries. Choose an arbitrary numeric/duration field calculation, or an explicitly selected person’s available working time. Group names never determine people or formulas. Summaries support editing and removal.

Use **Project dates** in the project header to set or clear an optional inclusive period. A summary can explicitly select **Project dates**, **This week**, or a custom range. Task dates remain independent. Missing project dates and project periods longer than 366 days produce clear unavailable states. This week uses the trusted workspace timezone and configured week start, including year boundaries. Custom availability periods are inclusive and limited to 366 days.

Available time is independent of task filters. It follows the person’s default working schedule and dated overrides, minus company holidays and approved absence; pending requests do not reduce it. The default schedule can apply before the first override, so dates before that override are not automatically unknown. Missing employment profiles or otherwise unknown schedules stay unknown. Tooltips show the person and dates.

**Working hours settings** opens the selected person in Time off → People & schedules, at Working hours. Configure employment dates and schedule periods there; summaries never change them.

**Override available time for this summary** accepts 0–527,040 whole minutes and an optional 200-character note. The display explicitly says **Manual**. Computed/displayed minutes remain separate; disabling the override restores automatic calculation. It affects only that summary, not employment settings, time-off balances or report Available. A missing period or unauthorized person/group remains unavailable even with an override.

Archived fields, missing groups and unavailable people do not produce plausible partial metric values. Capacity responses expose neutral dates and minutes, without leave notes, reasons, balances or types. Reads check current permissions, including manager-only former-member access.

## Related field and report improvements

Boolean custom fields use a real keyboard-accessible checkbox: checked means true, unchecked means false, and a mixed state means not set. Clear returns to not set rather than false. The control saves inline and retains the project’s Ctrl/Cmd+Z path while focused; Enter cannot accidentally submit a task form. Field settings keep initial select options and existing option editing accessible without squeezing the editor into a narrow panel.

Report capacity headlines use the server’s authoritative known-schedule subtotal. Mixed known/unknown teams are labeled partial; unknown schedules are never represented as a complete team total or used to imply a team utilization ratio. Reports link administrators to working-hours setup. Available may still be blank when a saved report has no explicit capacity/date range: choose **This week**, a custom range or **Use project dates**, then follow **Working hours settings** if needed; these temporary choices do not impose mandatory planning weeks. Category decoration follows the persisted project/field/option identity and valid saved color, so duplicate labels cannot exchange colors. These displays describe recorded task time and scheduled capacity, not attendance or a product-quality score.

## Persistence, compatibility and bounds

Footer measures and header widgets share the project aggregate-settings revision. Existing PUT `/api/v1/workspaces/:workspaceId/projects/:projectId/field-aggregate-settings` remains authorized and idempotent. Optional `headerWidgets` omission preserves current widgets; an empty array clears them. Older requests and replay responses receive no defaults, preserving their hashes and shapes.

Read-only POST `/api/v1/workspaces/:workspaceId/projects/:projectId/header-widgets/query` needs no write key. It accepts settings revision, grouping, hierarchy, supported filters and an optional source version. Authorization, configuration and source reads share one barrier. Stale versions conflict. Hashes normalize unordered source arrays and bind project revision, dates and resolved periods.

Migration `0022_table_header_widgets` adds nullable JSONB `generic_report_column_settings.header_widgets` and a bounded-array check. `0023_project_date_range` adds nullable `projects.date_range_from`/`date_range_to`, with a check requiring both NULL or an ordered pair between 1900 and 2200. Neither introduces defaults or backfills. Project dates use ordinary project.update authorization, revision, planning guard, replay and audit behavior. Omission preserves dates; explicit null clears them.

Bounds: 100 group rules, four widgets per group, twelve distinct metric fields, 100 distinct person/period capacity sources, and 5,000 canonical project tasks. Repeated sources are deduplicated. Overflows reject instead of truncating. Arbitrary expressions and nonnumeric filled-value counts remain outside this slice.

## Final verification and activation

All **13 final G gates passed with actual exit 0**, no skipped or flaky tests. These are scoped suites, not claims of full-repository unit/web coverage:

| Gate | Final G result |
| --- | --- |
| Global checks and isolated build | PASS; 1,508 source / 1,095 compiled |
| Focused unit | 267 tests / 13 files |
| Focused PostgreSQL | 39 tests / 7 files |
| Focused web | 452 tests / 57 files |
| Private compiled Chrome | 24 tests / 9 suites: manager 2, workspace 2, reports 6, Time off 3, spatial 3, Board 2, table widgets 2, field controls 2, capacity/colors 2 |

Exact proof catalogue: `/private/tmp/workloom-manager-reports-20261020/root-table-final-summary.json`; root release authorization: `/private/tmp/workloom-manager-reports-20261020/root-table-final-release.json`. G source/build root: `/private/tmp/workloom-manager-reports-20261020/build-cbb38a3e-e2c6-4ab4-a83b-d186e5850540`.

Activation proof: `.local/backups/table-widgets-bd3209d6-64cc-4fa1-8980-a7a5fec328d0/result.json`, `pass:true`. Only 0022 and 0023 were applied: 94 tables unchanged, ledger 22→24 with its previous prefix retained; all three new columns remained NULL. Old column row digests and schema objects, environment, PostgreSQL and Vite were conserved. No domain-data writes or database restore occurred. Only the owned API restarted (PID 45375→5833); worker remained OFF. All 335 previous non-HTML resources retained their bytes/MIME; two HTML entrypoints and all 363 merged resources were verified. Private QA was stopped successfully.

Actual main authenticated UI, live Auth/Google, real old-open-tab interaction and production were **not checked** by this private fake-Auth acceptance; no public deployment is claimed. Resource preservation is distinct from completing those workflows. Earlier generated-artifact restoration history remains in [98](98-project-and-workspace-manager-reports.md#generated-artifact-incident).

### Preserved failures and follow-ups

| Checkpoint | Historical result, not relabeled as G |
| --- | --- |
| A | Build RED: unsupported Testing Library role options and an incompatible generic selection-handler type. Explicit role queries and typed handlers corrected them. B built 1,095 files. |
| C | Global and 267 unit tests passed; PostgreSQL stopped at 36 PASS / 3 fixture failures before upgrade assertions. Drizzle’s transparent JSON serializers required explicit serialized JSONB bindings in historical fixtures. The three tests then passed privately; final G reran all 39. |
| D | Global, unit 267, PG 39, web 448, manager/workspace 2 each passed. Reports native stopped at 3 PASS / 1 FAIL / 2 unrun: chart height 673px exceeded the unchanged 650px limit. Compact headers (`876b009`) passed all six E reports cases without relaxing it. |
| E / focus diagnostics | Two table fixtures received HTTP 400 before UI checks because their accounting date preceded the first policy year; fixtures were corrected. Boolean focus diagnostics exposed an Undo receipt masked by clean focus capture (H: 1 FAIL / 24 name-filtered diagnostic skips), followed by acknowledgement focus loss when the review button retired (J: 1 FAIL / 25 name-filtered skips). Boolean-specific capture and acknowledgement retirement fixes (`d22987d`) retained native assertions; focused I 89/8 and K 69/6 passed. Final G field controls passed 2/2. |
| F | Table widgets had 0 PASS / 2 FAIL: raw UUID widget keys could begin with a digit, violating the letter-first key schema. `b0efabd` prefixes new keys with `w_` and preserves existing edit keys. Actual Add/Save unit coverage included a digit-first UUID (6 tests / 2 files); an initial ambient-config type check remained RED before a proper-ambient rerun passed. Final G table tests passed full-scope 6h and manual 32h→automatic 40h cases. |

A bounded subscription Claude CLI task (`--model opus`, code/tests only, no secrets or database data) timed out after 480 seconds without a usable proposal: `/private/tmp/workloom-header-widgets-opus-gvjun5bd`. Codex completed the backend tests. The packet manifest preserves source drift rather than attributing later fixes to that snapshot.
