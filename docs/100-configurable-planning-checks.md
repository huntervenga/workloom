# Configurable planning checks and neutral checkpoints

**ACCEPTED AND ACTIVATED LOCALLY.** Product `98a6d24` (`98a6d2401f224f769e8316bbb835aedb3349ce33`), final Candidate C: 1,551 source files / 1,127 compiled artifacts. Source SHA-256 `42cc8275f8895b97f1b6b13a2db95037954fd5f0b5fc20b75f6bdf2c31358b49`; build manifest SHA-256 `da17c0e10de19dca28117e260f723d8edc3eac117be1439db327ec4dfb840c3d`. Controlled activation completed **20 October 2026, 11:46:04 Asia/Nicosia** (`2026-10-20T08:46:04.918Z`). This documentation-only follow-up is later than the verified product snapshot. Previous table summaries and field controls remain documented in [99](99-table-summaries-section-widgets-and-field-controls.md).

Open the [demo project](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d) or its [Reports](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d/reports). These are entry links, not evidence of a newly checked main authenticated session.

## Use the feature

Open a project’s task table and choose **Checks**. Enable planning checks, add or edit a rule, choose **Apply rule**, then **Save checks**. Apply rule updates the settings draft; Save checks persists the whole configuration. Checks are optional visual reminders: they do not block creating tasks, changing values, or saving an incomplete plan. The owner or administrator configures them; other authorized project readers can inspect the resulting warnings. Disable project checks or an individual rule to suppress its warnings without deleting its configuration.

For a particular ordinary custom field, its field menu or field settings provide **Highlight missing values**. Select the emphasis and highlight color. Empty values receive a compact advisory; zero and Boolean No are valid filled values. Clearing a Boolean is different from setting it to No. The rule points to the field ID, so renaming the column does not break the check. There are no special Hours Estimation or Fact names in this system.

A section or assignee header offers **Configure planning checks for this group**. A Planning load rule selects a numeric or duration field to sum, the actual section or assignee identity, and a comparison target. A section is never treated as a person because of its title. For individual load summaries, configure the **Planning load rule’s grouping as Assignee**, select the actual assignee, and select a capacity person explicitly. Changing only the table’s visual Group by setting does not change the configured rule. A section warning remains a section issue even if its name resembles an employee or its target uses that employee’s capacity; it does not populate that employee’s under/overplanned count. Select a person explicitly to compare a duration plan with their computed working capacity. Alternatively select a fixed target in the field’s unit. A manual planning target applies only to this check and does not replace working schedules or Available hours elsewhere.

Choose a task date cohort if the plan should cover the same period as capacity: due date or an ordinary date field, with This week, Project dates, or a custom inclusive range. This week uses the workspace timezone and week start. Project dates must be configured and the range must not exceed 366 days. All tasks remains a valid explicit choice; the interface warns that this includes tasks outside the capacity period. Different plan and target periods are also labeled rather than silently presented as equivalent.

Underplanning and overcapacity bands can be enabled separately. Set warning thresholds, full-intensity thresholds, and both endpoint colors. For example a 40-hour target with warning above 100% and full intensity at 150% gives a weaker warning at 45 hours and full intensity at 60. The rule does not hardcode these values. Missing planned values normally make the comparison unknown; **Compare the known subtotal** explicitly permits a partial comparison and displays coverage.

Overdue task rules use due dates and the workspace-local current day. Included status groups, grace days, intensity and colors are configurable. An undated task is not silently considered overdue. A separate presence rule can highlight a missing ordinary date field.

## Reports and history

The project Reports page contains a current planning-check assessment, team and person summaries, rule outcomes, group comparisons and an issue review list. Assessment scope is the project’s authorized workspace-visible home tasks, independently of loaded table pages and saved report filters. Visible linked tasks are excluded and their count is disclosed. Filters explicitly configured on each rule still apply. This keeps an undated task visible to an appropriate missing-value check instead of losing it through an unrelated report date filter.

Missing-required and overdue counts are distinct tasks across overlapping rules. Per-rule counts may overlap. Underplanned and overplanned counts are groups, not tasks. Person counts use primary assignees or explicitly configured assignee groups; a mixed section’s planning warning is not assigned as personal fault to the selected capacity person.

Capture a named checkpoint to retain a neutral, immutable assessment and its exact rule configuration. History begins with these explicit captures. There is no automatic capture job, reconstructed historical trend, or claim that today’s assessment describes earlier weeks. Current reads write no history. Configuration changes use the existing audit flow; ordinary field history remains separate.

Checkpoint records contain counts, group results, configuration IDs and capture metadata, without task flags, task titles, descriptions, raw field values, or leave notes. Their neutral headers remain browsable when a historical person becomes unavailable; protected detail is checked against current access and can be denied. Past assessments are never substituted with recalculated current results.

## Contract and storage

Seven routes are below `/api/v1/workspaces/:workspaceId/projects/:projectId/planning-checks`: settings GET/PUT, readonly query POST, issue-list GET, checkpoint-list GET/capture POST, and checkpoint-detail GET. Configuration writes require the existing field-management capability. Reads require project/report access. Settings and captures use revision checks, scoped idempotency keys, atomic audit/outbox receipts, and current authorization even on replay. Issue paging requires the source digest so changed input cannot silently mix pages.

Migration `0024_project_planning_checks` adds only `project_check_settings`, `project_check_settings_versions`, and `project_check_checkpoints`. Existing rows are untouched and fresh projects remain disabled with an empty configuration until configured. Version and checkpoint records reject UPDATE, DELETE and TRUNCATE. The journal moves from 24 to 25 entries; controlled activation verified the original schema/data/ledger prefix and the three new empty tables. No real project checks, demo configuration or checkpoint data were seeded automatically.

Bounds are 50 rules, 12 distinct custom field IDs, 5,000 visible source tasks, 100 people/groups within existing source limits, 366 inclusive days per capacity/cohort range, 100 issue rows per page and 1,000 stored checkpoints per project. Overflow is an explicit failure. Rational arithmetic preserves exact sums, comparisons and gradient thresholds; unknown, zero target, no known plan and disabled states remain distinct. Capacity retains current working-calendar authorization and accounts for approved absence, not pending requests.

## Final verification and activation

All **16 final C gates passed with actual exit 0**, without failed, skipped or flaky cases. These are finite scoped suites, not full-repository test counts.

| Gate | Final C result |
| --- | --- |
| Global checks and isolated build | PASS; 1,551 source / 1,127 compiled |
| Focused unit | 346 tests / 20 files |
| Focused PostgreSQL | 46 tests / 9 files |
| Focused web | 495 tests / 67 files |
| Private compiled Chrome | 30 tests / 12 suites: manager 2, workspace 2, reports 6, Time off 3, spatial 3, Board 2, table widgets 2, field controls 2, capacity/colors 2, planning fields 2, planning settings 2, planning reports 2 |

Proof catalogue: `/private/tmp/workloom-manager-reports-20261020/quality/build-40554804-4213-4db8-b7d8-8a38c9c9ab9a/final-quality-C-gates.json`, SHA-256 `4f4ab321b3e08bb3d5b2ffbd84c625f5dc62da052b77deb69412337315a40757`. Root release authorization: `/private/tmp/workloom-manager-reports-20261020/root-quality-C-release.json`. QA helper SHA-256 `f3a3f40465b61335b8ef1086879bddb46576a6752b0304967f15c8520c79e1e8`; activation helper SHA-256 `a38939b24a4c9b2cd2a221c44a01db81916401c22f90eac7939cc85833b28194`.

Root reviewed light and settled dark warning cells, under/near/far load chips, compact toolbar, dark settings drawer and current report. Native history checks passed. Supplementary screenshot-driver failures and a transitional image remain diagnostic history, separate from the accepted gates.

Activation proof: `.local/backups/planning-checks-ecb2bc2f-aa7a-4ff3-9559-8d63140577bf/result.json`, `pass:true`. Only migration 0024 was applied: 94 existing tables conserved, three new empty tables, total 97; ledger 24→25 with its original prefix preserved. Previous column row digests/schema objects, `.env`, PostgreSQL and Vite remained unchanged. There were no domain-data writes or database restore. Only API restarted (PID 5833→45264); worker stayed OFF. Promotion touched only API/web/contracts/database/domain dist. All 361 previous non-HTML resources retained bytes/MIME; two HTML entrypoints and all 388 merged resources were verified. Root separately checked main readiness HTTP 200 with body status/database/schema OK.

Private QA stopped successfully at `2026-10-20T08:46:48.292Z`: `/private/tmp/workloom-manager-reports-20261020/quality-runtime-stopped-71bee9de-633d-4e2d-a12a-0d1ef099ecff.json`, `cleanup:true`. The C build’s `final-C-cleanup-verification.json` additionally confirms both recorded processes absent, no listeners on private ports 49318/49319/60651, and removed state; SHA-256 `c8193690ae2ff0de010eaee18e1ce834dfb498aacc65e7b807fde47934730395`.

Actual main authenticated UI, live Auth/Google, real old-open-tab interaction and production were **NOT CHECKED**. Private synthetic Auth does not cover them. Resource conservation is distinct from a completed old-tab workflow; no production deployment is claimed.

### Preserved failures and provenance

| Checkpoint | Historical result, not relabeled as final C |
| --- | --- |
| Developer build | A missing exhaustive planning-intent branch failed the initial private build; it was corrected before passing private package types and 65 focused unit cases. |
| Developer PostgreSQL | Six cases passed and one fixture failed before assertions because it requested private visibility unsupported by the shipped enum. The impossible fixture was removed, without altering the enum. Seven actual shipped-schema cases then passed; owned developer PG60652 was stopped and verified. |
| Candidate A | Build/start/inspector, global and four native suites passed (12 browser cases). Root rejected an unnecessary empty Checks toolbar row on visual review and held remaining checks. `71ceb0c` compacted it; A is not relabeled as a failed test gate or complete acceptance. |
| Candidate B | Seven gates passed before web stopped at 493 PASS / 2 fixture failures: the existing ColumnAggregateRecovery fixture did not mock new default-disabled check routes. Fixture-only `98a6d24` preserved recovery assertions and retries; all 1,127 compiled C artifacts are byte-identical to B. Final C reran all 16 gates. |

A bounded subscription Claude Opus code-only packet proposed the rational evaluator and tests; its successful run and actual model are retained under `/private/tmp/workloom-planning-math-opus-pa8vqjf8`. The implementation corrected its whitespace proposal to match JavaScript trim exactly, including FEFF and excluding U+0085. No secrets or database content were included.

## Current limits

Private task ACL is unsupported by the shipped schema and **NOT COVERED**; the reviewed workspace-visibility source predicate is not private-ACL end-to-end proof. This feature supports project home-task assessments, not a workspace-wide check rollup, foreign-project field sources, an arbitrary formula language or automatic background checkpoint capture. Periods are optional and explicitly configured; there is no mandatory weekly planning object. Recorded plan/fact versus capacity describes planning and recording coverage, not physical attendance, actual work dates or a product-quality score. Existing dated-worklog and future report-engine limits remain in [98](98-project-and-workspace-manager-reports.md) and [96](96-workspace-report-trends.md).
