# Workloom UX verification — 16 October 2026

Active evidence ledger for [the new daily UX run](24-current-ux-run.md). Author: Codex gpt-6.1-sol high. Initial source checkpoint: `7e1c6da`. Earlier accepted P0–P5b gates remain in [11](11-implementation-progress.md); they are not reruns of this candidate.

## Initial read-only browser audit

Actual capture interval: **2026-10-16T07:40:56.609Z–07:41:10.796Z**. Cached Playwright Chromium 1248, desktop **1440×1000**, mobile **390×844**, optimized app `127.0.0.1:4310`. Existing synthetic project `f477730b-57dc-418f-a46b-0eeab30f8212`.

Each context blocked all requests except GET/HEAD/OPTIONS. No blocked write request was attempted, no page error was observed, and document width equalled viewport width on both sizes. The task-title control opens the drawer through a URL parameter; source was checked before use. Automatic review initially mistook the Russian task title for a write action; source evidence and the HTTP-method barrier resolved that concern, and the approved retry completed. No data or runtime changes occurred.

Durable evidence directory:

`/Volumes/HunterVenga/AiData/.codex/visualizations/2026/10/15/01a1411c-a933-71a2-9e09-ef01489bc313/workloom-evidence/v2-before/`

Files: `audit.json`, `desktop-table.png`, `desktop-drawer.png`, `desktop-week.png`, `mobile-table.png`, `mobile-drawer.png`, `mobile-week.png`. The JSON records actual URLs, visible text, geometry, errors and method-blocker results. Screenshots alone do not establish write correctness.

| Rank | Reproduction | Observed friction |
| --- | --- | --- |
| 1 | Open project at 390×844, leave scroll at top | Table starts at y=1200.5; project title, seven actions, tabs, week controls and filters consume more than a screen before tasks. Desktop table begins y=605.7. |
| 2 | Open an existing task title | Mobile drawer's first viewport reaches priority only; dates, participants, tags, dependencies and fields require more scrolling. Repeated privacy/help copy and a long permanent edit form delay the task summary. |
| 3 | Read default desktop table | 1340px table in roughly 1072px available width; status and assignee truncate, several custom fields lie beyond local horizontal scroll. Mobile needs substantial local pan. |
| 4 | Open project `/week` at 390×844 | No personal plan, fact or meeting is visible in the first viewport. Period administration, freeze actions and guidance occupy the page before work. |
| 5 | Navigate all three surfaces | Chrome is Russian, mixed with English synthetic names; domain guidance repeatedly dominates daily controls. Existing Russian task/project names are user data. |

The initial audit is a baseline, not an acceptance failure of an implementation that has not landed. Root and the relevant UI owners received the ranked findings.

## Planned acceptance scope

Preserve existing real API/PostgreSQL browser coverage when updating English labels. Update selectors to the actual English semantics; do not remove assertions, replace unknown writes with fresh keys, hide failures, or turn distinct missing/zero/void states into the same expectation. New low-impact layout changes need measured browser checks rather than mirror tests.

| Gate | Status | Evidence |
| --- | --- | --- |
| English catalog completeness and namespace consistency | Owner gate passed | Initial foundation audit: 158 files / 2,274 calls / 2,213 English messages; later checkpoint audits and JSON-only browser proof below |
| Build, types, lint and affected web tests | Coordinator/owner gates passed | Root full build/lint/audit passed; initial full web 299/300, repaired legacy title assertion file 10/10; not one green 300-case run. QA scoped lint/root tests TypeScript passed. |
| Existing browser workflows, desktop/mobile | 26/26 passed | Frozen optimized checkpoint `614bad9`, final complete suite 2.6m; migration provenance below |
| GET-only final desktop/mobile screenshots and geometry | 10 surfaces passed | 08:41:50.031–08:42:23.805; zero attempted writes, page errors or global overflow |
| Startup helper fail-closed identity checks | 10/10 operations tests passed | Bounded process/atomic-state/journal/schema seam tests below |
| Existing database persistence and helper start/stop | Controlled restart passed | Exact 54-table / 11,480-row pre/post snapshot match; not OS reboot |
| Old-tab upgrade behavior | Not tested in this run | Must be reported separately |
| Real Auth/private ACL/production | Outside this local synthetic scope | No claim |

## Project-list data hygiene

Initial GET inventory: one accessible workspace, **183 active projects**, six synthetic memberships. Prior test projects remain present and must be preserved. A clean additive demo is preferable to deleting history. A seventh synthetic actor needs a coordinated allowlist/fixture decision; inserting an arbitrary user would not create a valid selectable dev identity.

## Gate log

The gates below retain initial failures and corrections. Do not sum overlapping test-suite counts.

### Runtime helper candidate

Implemented `scripts/local-runtime.mjs` and [operations guide](26-local-runtime.md). Read-only doctor verified the existing PostgreSQL, API and Vite, all **not owned**, without adopting/signalling them. Four pure Node tests passed (PID reuse/start-time/cwd/command rejection, exact service identity, existing-cluster identity, local-only environment). Scoped lint initially found Node web-global declarations and dynamic delete; the helper now uses `globalThis` and explicit object replacement. Corrected scoped lint and all four tests pass. No runtime start/stop occurred. Candidate still awaits root review and a controlled runtime window.

### First compact checkpoint (development UI only)

GET-only Vite capture completed **07:52:22.033 UTC**. Evidence is in `workloom-evidence/v2-compact-checkpoint/`: six desktop/mobile table/drawer/week frames, `audit.json`, and `row-geometry.json`. This is a partial implementation checkpoint, not the final optimized build. All eight actual tasks were settled and measured; row height remained 44px. No write request was attempted, no page error occurred, and global horizontal overflow stayed zero.

| Actual first task row | Initial compiled UI | Compact Vite checkpoint |
| --- | --- | --- |
| Desktop 1440×1000 | y=683.15625 | y=401.5 |
| Mobile 390×844 | y=1278 | y=441.5 |

Table width changed from 1340px to 1086px desktop / 820px mobile. Local horizontal panning remains necessary on mobile. The weekly page now exposes a personal-plan card in its first mobile viewport. Existing Russian project/task/status data was preserved; English chrome is separate from translating stored content.

### Read-only shell browser gate

`playwright test tests/e2e/p0-shell.spec.ts --reporter=list` against Vite: **6/6 pass, 21.9s**. Each test enforced GET/HEAD/OPTIONS only and asserted zero attempted mutations. Real cases cover current actor/workspace/members, unknown workspace and mobile layout. Delayed response, mocked 503/retry and mocked empty-list cases retain their explicit provenance. Accessible labels were aligned with Members, Local demo and the compact topbar synthetic badge; identity/member-count and unavailable-state assertions remain.

### Offline operations and recovery checks

Current helper/journal suite: **10/10 pass**, scoped lint pass. In addition to process guards, actual temporary-file tests cover private atomic replacement, old-file survival on failed serialization, native fetch's boolean `ok`, redirect refusal/deadline, write-ahead original serialized body/key before send, disk reload after a committed-but-lost acknowledgement, exact replay despite a changed proposal, and replay-before-preview for pending meeting-plan/freeze receipts. These are bounded offline seam tests; no database/domain mock is presented as integration evidence.

Original-row preservation uses independent **READ ONLY REPEATABLE READ** snapshots, UTC JSON canonicalization, statement timeout 15s, lock timeout 3s and idle-transaction timeout 30s. A real read-only metadata check confirmed **54 public tables / 54 with primary keys**. This validates the snapshot key catalog, not the unexecuted demo setup.

### Temporary second-locale smoke — initial attempt

The initial real Vite smoke discovered temporary French JSON files, exposed the language selector, changed `document.lang`, and retained unsaved title/description/priority/invalid-estimate values with client validation and zero writes. It then failed a **QA namespace assumption**: sidebar Projects uses `routes.projects`, while the temporary fixture translated `shell.projects`, so the correct English fallback remained. This is not a product translation failure. Evidence: `workloom-evidence/v2-locale/initial-proof.json`. The temporary locale was removed in `finally`. A corrected smoke including translated existing validation errors is pending the targeted task/name-form state fixes.

### JSON-only second-locale browser proof — passed

Final interval **2026-10-16T08:17:10.345Z–08:17:24.241Z**, Vite 4311, desktop 1440×1000. Only temporary `locales/fr/*.json` files were added; no app import or locale registry changed. They were removed in `finally` before the build window. **Zero attempted HTTP writes, zero page/console errors.**

Actual checks: the language selector appeared through JSON discovery; French labels and an already-visible estimate validation error updated live; missing French messages fell back to English; `html.lang` changed; actual task due-date text changed `Oct 14` → `14 oct.` without changing the stored date; a newly loaded tab restored the explicit French preference. Switching back to English preserved unsaved task title, description, optional priority, invalid estimate and current validation state. Closing/reopening and resubmitting the same invalid draft preserved values and repeated client validation without a request.

Evidence: `workloom-evidence/v2-locale/proof.json` and `desktop-unsaved-fr.png`. Earlier attempts remain as `initial-proof.json` (wrong QA namespace), `second-proof.json` (a QA import created a second Vite module instance for the formatting probe), and `third-proof.json` (role-based lookup excluded the modal-hidden background date cell). The final proof uses the actual rendered date cell, not a parallel manager import. Locale arithmetic remains covered separately by manager unit tests. None of these QA failures is presented as a product locale failure; the final browser gate does prove the targeted task-error descriptor fix.

### Controlled durable-runtime restart — passed

Coordinator authorized the exclusive runtime window after the full build. Snapshot before **08:20:01.258 UTC**, snapshot after **08:21:38.126 UTC**: all **54 public tables / 11,480 rows** retained exact counts and canonical UTC full-row SHA256 digests, `changed=[]`. Both snapshots used READ ONLY REPEATABLE READ. This is a real controlled restart, **not an OS reboot test**.

Only the previously verified root-owned API 6770, Vite 6812 and exact PostgreSQL 7471 cluster were normally stopped, after start-time/command/cwd checks. The reviewed helper then started all three, doctor verified ownership/readiness, helper stopped all three normally, and helper started all three again with a second doctor pass. Final observed helper-owned PIDs: PostgreSQL **25126**, API **25140**, Vite **25254**. Worker remained OFF. No initialization, migration, restore, existing seed or forced kill occurred.

Private proof: `.local/runtime/restart-before-20261016.json`, `restart-after-20261016.json`, `retired-root-processes.json`, `processes.json`. User data stayed in the existing durable `.local/postgres/data`; credentials were not changed or printed.

### Frozen optimized browser candidate

The initial source checkpoint is **`614bad9`**. Authors may continue development source on 4311, while the acceptance suite targets the frozen compiled app **4310** through ignored `.local/playwright.current.config.ts` with `webServer` disabled. No build/dist change/API restart is allowed during this gate.

At **08:22:38.669 UTC**, all **12 HTML/JS/CSS/lazy assets** returned 200, correct MIME and exact current `dist` bytes; readiness body reported database/schema `ok`. Entry `/assets/index-CpasMMhd.js`, 767,031 bytes, SHA256 `d7860dfd60403ddd7a8952dad2edf992e145cbe0283f932f93f17b46fe08d454`. Private manifest: `.local/runtime/assets-before-e2e.json`. At **08:39:26.296 UTC**, the post-suite manifest compared all 12 assets unchanged and readiness again returned database/schema `ok`; `.local/runtime/assets-after-e2e.json`. The final complete browser run passed **26/26 in 2.6m**. Runtime assets remained fixed while authors continued source-only work on 4311.


### English/disclosure browser migration — complete 26-case gate

Command: Node 24 Playwright CLI `test --config .local/playwright.current.config.ts --max-failures=3 --output test-results/v2-full-final --reporter=list`, cached Chromium 1248. Final log: `/tmp/workloom-v2-browser-full-final.log`. All **26/26 passed (2.6m)**, including desktop/mobile shell, task create/edit/subtasks/filter/revisions, typed fields/history, plans/freeze/facts/reports, shared meetings and DST, exact lost-acknowledgement retries, dependencies/layout, date batches/baselines, CSV reconciliation and local credential issue/read/revoke. Main-database test fixtures are additive; credential-secret traces/screenshots remain disabled where required.

Tests now use independent English accessible labels and the real compact disclosures. Assertions preserve distinct zero/missing facts, immutable baselines/history, exact original keys/content after committed-but-lost responses, revision guards and actual browser/API persistence. Explicit All columns is selected again after a deep link resets the Daily view. Radio selection waits for the actual query state before closing its disclosure; Saved report/breakdown select locators specify combobox role. Header-derived desktop estimate-cell indexing accounts for the changed visible preset.

Initial attempts remain distinct from this final gate:

| Log under `/tmp/` | Actual result | Resolution |
| --- | --- | --- |
| `workloom-v2-browser-initial.log` | 8 pass, 3 fail, 1 interrupted, 14 not run | Stale cutoff label plus real project-actions overlay; interrupted by verified runner PID to cap obsolete-selector timeouts |
| `workloom-v2-browser-targeted-first.log` | 2 fail, 2 not run | QA radio/check URL race |
| `workloom-v2-browser-targeted-second.log` | 1 pass, 2 fail, 1 not run | Explicit column preset after deep link; disambiguate report combobox |
| `workloom-v2-browser-targeted-third.log` | 3/3 pass | Corrected task-field/weekly setups |
| `workloom-v2-browser-remaining-first.log` | 6 pass, 3 fail, 5 not run | Same menu overlay, one stale English-copy selector, date-label whitespace |
| `workloom-v2-browser-remaining-second.log` | 7 pass, 1 fail | Final mobile date-label whitespace locator |
| `workloom-v2-browser-full-final.log` | **26/26 pass** | One complete frozen-candidate rerun |

The native Project actions menu remaining open behind a modal is a **real UX defect** in this checkpoint. Initial tests close the real menu after the modal before opening View or global actions. This is an explicit user workaround, not a product fix. The task owner has a source fix for the next checkpoint; it is not in these frozen assets. Gantt label whitespace was a small visible polish finding; exact date assertions tolerate whitespace while retaining the full dates. No final test result establishes complete product UX quality, real Auth/private ACL, production or old-tab upgrade coverage.

### Additive synthetic showcase — executed and preserved

Actual interval **2026-10-16T08:39:35.113Z–08:39:39.804Z**. Reviewed `scripts/bootstrap-daily-demo.mjs --execute` completed all **82 acknowledged domain/API commands**, plus the single additive workspace/six-membership bootstrap transaction. Current date **2026-10-16**, planning week **2026-10-12**, Asia/Nicosia. New workspace **Workloom Studio**, two concise projects, **18 tasks** including one shared meeting; existing six actor names unchanged. New-project statuses are English.

Before/after READ ONLY REPEATABLE READ proofs matched all **54 original public tables / 14,647 original rows**, including the additive E2E fixtures already present before setup. No original row changed or disappeared. This larger count is after the browser suite; the earlier restart's 11,480-row snapshot is a separate gate. Private manifest `.local/demo/daily-v1.json` retains original key sets/digests and command body/key/response acknowledgements; `/tmp/workloom-v2-demo.log` contains the completion summary. No old workspace/project/user deletion, archive, rename, initialization, restoration or migration occurred.

The real saved weekly report has **2,370 planned minutes (39h 30m)**, **1,255 actual minutes (20h 55m)**, complete known estimates and **12/16 recorded facts (75%)**. Missing facts keep total variance/percent **null**. Work-type totals reconcile: Delivery 645, Research 405, Teamwork 115, Quality 90 minutes. `protectEstimate=false` preserves editable current estimates alongside the genuine immutable baseline. See [27](27-synthetic-demo.md) for the stable entry links and recovery rules.


### Final clean-workspace visual frames

GET-only capture **08:41:50.031–08:42:23.805 UTC**, compiled checkpoint `614bad9`, Chromium 1248, desktop 1440×1000 and mobile 390×844. Evidence directory `workloom-evidence/v2-final-demo/`: table, existing-task drawer, personal week, saved weekly report and work-type report on both sizes, plus `audit.json`. All ten surfaces had **zero page errors and zero global horizontal overflow**; no write was attempted. Local table/report panning remains explicit. The script initially waited for a nonexistent singular heading instead of the actual plural Personal plans region; `initial-capture-selector.json` preserves that QA-only attempt before the corrected ten-frame capture.

All 12 compiled assets remained exact after the demo/captures at **08:43:29.401 UTC**, with ready database/schema bodies (`.local/runtime/assets-after-demo.json`). Final helper doctor verified all three services still owned and ready. The exclusive frozen-build window was then released to the coordinator. Next-source features and menu-overlay fixes require their own build/browser gates.

Root visual review found the desktop drawer screenshot still contained `Checking predecessors…` and custom-field skeletons. It is **not settled field/dependency visual evidence**. The next combined checkpoint must wait for concrete loaded field/dependency state before capturing the drawer. The clean task row itself was separately measured at y=401.5 desktop / 441.5 mobile (44px height), excluding the preceding section header; `v2-final-demo/actual-task-row.json`.


### Second checkpoint: Studio restart persistence and focused browser gate

Compiled source checkpoint **`2d02bc4`**. Coordinator reports all workspace builds passed, full lint passed, and 355 distinct web cases covered passing across the initial 350/354 run and a repaired 21-case subset (including a new discovery case); **not one clean full 355-case run**. These are coordinator source gates, separate from the browser evidence below.

At **08:54:06.592–08:54:32.026 UTC**, helper-owned normal stop/start preserved all **54 public tables / 15,247 rows** with exact counts/full-row digests, `changed=[]`. This snapshot now includes Workloom Studio's tasks, baseline, facts and reports, directly proving their controlled-restart persistence. Worker stayed OFF; no initialization, migration, seed or restore. Private snapshots: `.local/runtime/studio-before-restart-20261016.json` and `studio-after-restart-20261016.json`.

Doctor verified all three restarted services owned/ready: PG **34550** and API **34563** (start 11:54:15 Asia/Nicosia), Vite **34597** (11:54:16). At **08:54:34.068 UTC**, actual optimized inventory contained **14 assets: HTML plus 13 JS/CSS**, all 200/correct MIME/exact dist bytes, database/schema readiness `ok`. Entry `/assets/index-BWzG8-Rh.js`, 772,805 bytes, SHA256 `5f779357e7fbabda3b26d60ee01b2b3aaba6ffecf5fd0fcf34e6c91ece1c2daa`. Manifest `.local/runtime/assets-before-focused.json`.

Eight focused browser cases were authored in `p6-daily-ux.spec.ts` and `p6-time-context.spec.ts`, with fresh additive projects in the explicit original workspace. Workloom Studio is excluded from these writes. Owned lint, root tests TypeScript, whitespace check and collection of exactly eight cases passed before execution. One complete final focused run passed **8/8 in 56.8s**, after the bounded QA corrections below. The unchanged earlier 26-case suite was not rerun for this checkpoint. Actor-switch/revocation browser coverage is not claimed from current-actor or separate HTTP/PostgreSQL checks.


#### Focused browser results and initial QA attempts

Final command: Playwright CLI `test tests/e2e/p6-daily-ux.spec.ts tests/e2e/p6-time-context.spec.ts --config .local/playwright.current.config.ts --max-failures=2 --output test-results/v2-focused-final --reporter=list`. Log `/tmp/workloom-v2-focused-final.log`, **8/8 pass (56.8s)**. Real desktop/mobile checks cover:

- Current-actor My tasks across two projects, responsible/participating/completion/search filters, actual existing drawer navigation, edit and refetch after returning. No client actor/membership selector is sent to the inbox endpoint.
- Section Enter creation once, no drawer or optimistic task row, explicit status/assignee/due saves with only the intended field and exact seen revision, and no write from selection/blur.
- Real committed quick/inline writes whose response is held while collapsing/reopening the editor, followed by the original late confirmation without duplicate submission. A genuinely committed due-date response is then lost; Retry sends identical bytes/key and produces only one revision.
- Project actions → Columns → close → View without the initial checkpoint workaround; focus returns to the visible action summary. This accepts the overlay fix in `2d02bc4`.
- Explicit empty week, selected week/person round-trip, separate per-person plan drafts, independent report cohort, and a saved-row-person task link opening a currently authorized task in a new tab while preserving the saved report and ambient person.
- Acting person outside a meeting roster leaves attendance unselected. Saved actual details begin collapsed; an unsaved duration change survives close/reopen. Browser writes remain zero in the time-context cases, actual/attendance server records unchanged. Leaving with retained drafts explicitly requires the correct unsaved-change confirmation.

| Log under `/tmp/` | Actual result | QA correction |
| --- | --- | --- |
| `workloom-v2-focused-first.log` | 2 fail, 1 interrupted, 5 not run | Actual quoted section-action label; role combobox for wrapped My involvement select; verified runner interrupted to avoid repeated obsolete-selector timeout |
| `workloom-v2-focused-second.log` | 6 pass, 2 fail (28.6s) | Distinguish footer Close from header Close icon |
| `workloom-v2-focused-time-first.log` | 2 fail | Role combobox for wrapped Whose attendance select; actual snapshot already showed the correct empty choice |
| `workloom-v2-focused-time-second.log` | 2 fail | Explicitly assert and accept the correct Leave this page? draft guard before returning |
| `workloom-v2-focused-time-third.log` | 2/2 pass (21.6s) | Both remaining time-context cases complete |
| `workloom-v2-focused-final.log` | **8/8 pass (56.8s)** | One complete final run |

These failed attempts are new QA integration assumptions; none established a product failure in this checkpoint. The real native-menu defect from `614bad9` remains documented separately and is now verified fixed.

Four **changed** existing P2a/P2b desktop/mobile cases were then checked because fixed task/person selectors were replaced by visible Time entry context summaries. P2a selects Time entry for before opening its fixed-person form; fixed table forms assert task/person/period text and hours-first focus. The real command target, work-package identity, revision, exact lost-ack body/key, zero/correction and immutable report assertions remain. Initial `/tmp/workloom-v2-weekly-changed.log`: **3 pass / 1 fail (31.1s)** at one further obsolete Whole task selector. Corrected visible target assertions and reran only that desktop case: `/tmp/workloom-v2-weekly-changed-desktop.log`, **1/1 pass (19.6s)**. Thus all four changed cases are covered passing; this is **not a single green four-case run**, and the other 22 unchanged cases were not repeated.

All browser-test ESLint, root test TypeScript and `git diff --check` passed after the corrections. At **09:04:22.083 UTC**, all **14 optimized assets remained exact** against the pre-focused manifest; API database/schema body stayed `ok`, and helper doctor verified PG/API/Vite owned and ready. `.local/runtime/assets-after-focused.json`. Worker remained OFF. The exclusive window is released after this gate; later source edits are a separate candidate.

#### Settled visual correction

Actual interval **09:01:19.485–09:01:31.968 UTC**, GET-only `2d02bc4`, desktop1440×1000/mobile390×844. Evidence `workloom-evidence/v2-checkpoint2-settled/`: fourteen frames covering table, loaded drawer overview, loaded fields/dependencies, week and saved report/work-type results, plus `audit.json`. Every context blocked writes and recorded **zero attempted writes, page errors or global horizontal overflow**. Field/dependency screenshots waited for actual **Research**, **On track** and **No unfinished predecessors**, correcting the earlier skeleton capture. Mobile fields/dependencies fit together in one settled viewport, so their two named screenshots coincide. Saved report/work-type captures intentionally scroll to real saved results; they do not claim those results start in the initial page viewport. Root's results-first report/layout follow-up remains a later source change.


### Fresh pre-comments backup and actual restore verification

Coordinator confirmed main-database quiet; foundation's disposable comments tests completed and cleaned their owned databases before this separate backup window. No main migration was authorized or applied by this operation.

A fresh PostgreSQL17.5 custom archive completed **09:11:22.163 UTC**: `.local/postgres/backups/before-comments-20261016-b96eee92f8/database.dump`, **2,080,850 bytes**, SHA256 **`b812cc7e52a96c641579bc9ecc1b64741529c821535b9ad5aa9be554c667623c`**. Archive mode0600/private folder0700; credentials were parsed from the existing environment and passed only through child environment, never argv/logs. `pg_restore --list` read **634 catalog items**, including application table data and the migration ledger.

Separate before/after-dump READ ONLY REPEATABLE READ snapshots matched all **54 public tables / 16,835 rows** and the complete **11-row `drizzle.__drizzle_migrations` prefix**, SHA256 `90b0cbd29ab78927133d79889342c71097c94b5332bd4bcc42f1693c92855ca5`. The larger row count reflects the already accepted additive QA fixtures. This establishes quiet during the backup.

The archive was then **actually restored** into exact newly owned `workloom_test_backup_b96eee92f8`, using the existing private-socket peer maintenance seam through an ephemeral loopback bridge. All 54 table counts/full-row digests and the complete migration prefix matched the main pre-backup snapshot. Verification completed **09:11:23.673 UTC**; that own copy was normally dropped, exact remaining database count **0**, bridge closed. No force-drop, role/grant/configuration change, main restore, main schema change or service restart occurred. Private manifest `.local/runtime/comments-backup-20261016.json`; raw harness `/tmp/workloom-comments-backup.mjs`, metadata log `/tmp/workloom-comments-backup-result.log`.

At this backup checkpoint, reviewed additive0011 still required a **separate coordinator GO**. That authorization and its actual postconditions are recorded below; the backup itself did not apply it.


### Reviewed main0011 application and new runtime

Coordinator explicitly authorized **MAIN0011 GO** after accepting the reviewed SQL/journal/schema, 14 disposable PostgreSQL cases, and the fresh backup/actual restore proof. Source checkpoint **`bbc0e53`**: coordinator reports all-workspace build, full normal **388/388 web cases**, global lint and localization audit passed. These source gates remain separate from the browser gate.

Guarded normal migrator applied **only `0011_task_comments`**, **09:13:23.079–09:13:23.708 UTC**. Preflight required the exact12-entry journal ending0011 and the unchanged verified backup snapshot. Postcondition: all **54 original public tables / 16,835 rows** retained exact counts/full-row digests; all **11 previous migration rows** unchanged; exactly the expected12th receipt appended. New `task_comments` table empty. Seven expected constraints (including the memberships composite author identity), primary/timeline indexes and two active append-only triggers were present. Private proof `.local/runtime/comments-migration-20261016.json`; metadata log `/tmp/workloom-main-comments-migration.log`. No seed, backfill, main restore or future migration was applied.

Verified helper-owned services were normally stopped/restarted. Final observed PG **41621** / API **41634**, start12:13:44 Asia/Nicosia; Vite **41675**,12:13:45. Doctor verified all owned/ready. At **09:14:38.684 UTC**, a new READ ONLY REPEATABLE READ comparison preserved all **55 public tables / 16,835 rows** exactly against the immediate post-migration snapshot, before any comments browser writes; `.local/runtime/comments-after-restart-20261016.json`. Worker OFF.

Actual new API GET-only smoke **09:14:16.011 UTC** on the original clean Studio research task: comments0, explicit null cursor, activity1 with `created`, strict schemas passed, no writes. At **09:14:18.192 UTC**, all **14 optimized HTML/JS/CSS assets** returned200, correct MIME and exact dist bytes, database/schema readiness `ok`. Entry `/assets/index-D_tdw3Pv.js`,775,276bytes,SHA256 `f954938afe7911908bc2ee5c5e9eff85a75665109b9f378f2b2969314329e0d5`; `.local/runtime/assets-before-comments.json`.

Eight bounded comments/results-first cases were collected after owned lint/root tests TypeScript passed, with max-failures2. The **first complete browser run passed 8/8 (18.0s)**. Test write fixtures stayed in the explicit original QA workspace; Studio was GET-only. Viewer uses a real isolated allowlisted dev-session cookie via API setup, not a browser actor-switch UI. Subsequent injected403 is explicitly a cached-feed UI simulation, not real membership revocation.


#### Comments/results-first browser acceptance — first run passed

Playwright CLI `test tests/e2e/task-comments.spec.ts tests/e2e/report-setup.spec.ts --config .local/playwright.current.config.ts --max-failures=2 --output test-results/v2-comments-first --reporter=list`: **8/8 pass (18.0s), no failed test attempts**. Log `/tmp/workloom-v2-comments-first.log`. Desktop1440×1000/mobile390×844 actual cases:

- Unsaved task name/description survive Details/Discussion sibling tabs. Blank comments validate without a request; plain Enter inserts a newline, Ctrl+Enter posts once. Exact leading/trailing spaces, line breaks, literal HTML/script/Markdown persist in real PostgreSQL and after browser reload. React renders text without HTML/link/script execution. Trusted server author identity matches the current actor; task revision remains unchanged. Activity fetch begins only after explicit expansion and returns the strict safe public projection.
- A genuinely committed pending post survives drawer close/reopen and its original late acknowledgement clears that sent draft once. A second real committed response is deliberately lost, then exact Retry sends the identical original bytes/key and leaves one comment row for that operation. No task revision changes.
- A fresh isolated browser context obtains an existing allowlisted viewer through the real local dev-session API, verifies the resolved identity, reads the real saved feed with no composer, and receives real403 for API comment creation. A later scoped injected403 verifies the UI hides the previously loaded feed. That injection is **UI simulation**, not a real membership revocation; no fixture identity/permission was changed.
- Both saved weekly/work-type reports initially show a result metric inside the viewport with setup hidden. Expanding setup sends no POST. A new real calculation commits while its response is held; selecting saved report B before releasing that response keeps B's selector/URL/result instead of replacing it with the late result for A. Exactly one explicit calculation POST occurs per check. Both sizes have no global horizontal overflow.

Owned lint, root tests TypeScript and collection of exactly eight cases passed before execution. At **09:22:24.178 UTC**, all **14 optimized assets remained unchanged**, with database/schema readiness `ok`; `.local/runtime/assets-after-comments.json`. Helper doctor again verified PG41621/API41634/Vite41675 owned/ready, worker OFF. The exclusive mainDB/runtime window was released. Source-only `ac8cc25` personal-plan layout/personal-column work was not compiled or claimed by this gate.

#### Final comments/results-first visual proof

GET-only capture **09:21:57.320–09:22:04.033 UTC**, same frozen `bbc0e53`: six frames in `workloom-evidence/v2-comments-d1/`, `audit.json`. `desktop-discussion-literal.png` and `mobile-discussion-literal.png` show already-created QA tasks in the original workspace with the actual stored multiline literal comment. `desktop-report-initial.png`, `mobile-report-initial.png`, `desktop-work-types-initial.png` and `mobile-work-types-initial.png` show clean Studio selected results at their initial scroll position with setup collapsed. No Studio comment was created for a screenshot.

All six frames: **zero attempted HTTP writes, zero page errors, zero global horizontal overflow**. Current task data, comments and saved result values were loaded before capture. The first capture-only attempt matched both Total recorded and Categorized `20h 55m` values; its QA ambiguity is retained in `initial-capture-selector.json`. The corrected guard scopes the first actual metric; this was not a product error and did not affect the first-green eight-case test gate.

### Fresh backup before personal-column preferences

Coordinator authorized backup/read-only evidence and an owned restore copy separately from the still-pending MAIN0012 application. At **09:34:10.221 UTC**, native PostgreSQL17.5 produced private `.local/postgres/backups/before-preferences-20261016-ed00099736/database.dump`: **2,121,547 bytes**, SHA256 `028c0f7fd860ad558017ee32cbf050c2b56aca546dd8c73674d79f5e17b6dfe3`, readable archive catalog644 items. The private directory is0700; archive0600. No credentials appear in command arguments or tracked evidence.

READ ONLY REPEATABLE READ snapshots before/after the dump matched all **55 public tables / 17,177 rows** exactly. The **12 existing migration rows** matched SHA256 `50d67356547967aa727fb94d4784fd2254ac1edebe3083e974e3fd0f9e77a32f`. The archive was actually restored into exact unique owned `workloom_test_backup_ed00099736`; all55 table counts/full-row digests and the complete migration prefix matched. Verification completed **09:34:11.526 UTC**. That copy was normally dropped, exact remaining count0, ephemeral peer bridge closed. Private proof `.local/runtime/preferences-backup-20261016.json`; harness `/tmp/workloom-preferences-backup.mjs`. No main migration, main restore, seed or runtime restart occurred.

Eight source-only browser cases are prepared in `personal-columns.spec.ts` (four each desktop/mobile); scoped lint passed. The former View/All columns helper and shared-manager trigger selectors are migrated to the actual personal Columns/Team columns controls, preserving behavioral assertions. Execution and D2 geometry remain pending the coordinated preferences build/migration/runtime window. These prepared checks are not passes.

### Reviewed main0012 application and fourth runtime checkpoint

Coordinator separately authorized MAIN0012 after all-workspace build and global lint/boundaries/localization passed. The first normal web run covered436/437 passing with one report startup assertion failure; an11-case target reproduction passed, then a meaningful saved-read readiness test correction passed32 target/adjacent cases. Checkpoint `86e88b7` includes that test-only correction; compiled production source corresponds to `96c8da9` plus `72fbe92`. This is not claimed as a single clean437-case run.

Only `0012_personal_table_preferences` applied **09:43:15.248–09:43:17.444 UTC**, after the main database still matched the accepted fresh backup. All **55 original tables /17,177 rows** retained exact full-row digests; all12 prior migration rows were unchanged. Exactly the expected13th migration receipt appeared, the new preference table was empty, all six expected constraints and the primary index were present, and the structural validator was immutable/strict/parallel-safe. Private proof `.local/runtime/preferences-migration-20261016.json`. No seed, main restore or future migration occurred.

Helper-owned processes were normally stopped/started. PG56025 started12:43:43 Asia/Nicosia, API56039 at12:43:44, Vite56187 at12:43:46; doctor verifies all owned/ready, worker OFF. The old API's readiness became stale between migration and restart, as expected; it was ready after restart. At **09:43:57.194 UTC**, all **56 tables /17,177 rows** exactly matched the immediate post-migration snapshot, before browser writes. Private `.local/runtime/preferences-after-restart-20261016.json`. Studio GET-only preferences smoke at **09:44:11.820 UTC** returned200 and the strict own absent revision0/null DTO without writing.

At **09:43:55.419 UTC**, all14 optimized HTML/JS/CSS assets returned200 with correct MIME and exact dist bytes; readiness body database/schema `ok`. Entry `/assets/index-DnlVxC0w.js`,779,297bytes,SHA256 `57ce883768b01a00e0a04766b22833050c54c35a2ef534a507043872c4c3dc6a`. Private manifest `.local/runtime/assets-before-preferences.json` freezes this runtime independently of subsequent source-only work.

#### D2 actual compact personal-plan geometry

GET-only Studio capture **09:44:52.266–09:44:54.863 UTC**: all16 personal plans retained, four semantic columns, one row header and three data cells per row. Desktop row heights54.5–55px, median55px; mobile94–95px, median95px. Desktop actual-hours region begins at y1446 versus y2733 in the same original data before D2,1287px earlier; mobile y2084 versus3467,1383px earlier. No row clipping, global horizontal overflow, attempted writes or page errors. These are actual measured rows, not skeletons or fixed-height CSS targets.

Evidence `workloom-evidence/v2-personal-plans/after-D2.json` and desktop/mobile `-initial.png`, `-plans.png`, `-plans-end.png`; `before-D2.json` preserves the old130px desktop/174px mobile cards and all16 row geometry. Coordinator visually reviewed both settled plan frames and accepted readability/visible mobile status cells. Studio remained read-only.

#### Personal columns browser acceptance and preserved fast-action finding

Final complete desktop1440×1000/mobile390×844 run: **8/8 pass21.2s**, log `/tmp/workloom-v2-preferences-final.log` (created09:47:58.820,last output09:48:20.289UTC), outputs `test-results/v2-preferences-final`. Four behaviors per size:

- Real own visibility/order save changes built-in and custom columns; keyboard Due date reordering, hidden Status/custom field, visible Participants and exact persisted head survive reload. Shared defaults and task revisions stay unchanged.
- A real isolated allowlisted viewer session resolves its own actor, saves only its own head, reloads it, and explicitly resets to a stored null at revision2. Owner head and shared defaults stay unchanged. This is API session setup, not browser actor-switch/revocation coverage.
- A real preference command commits and its acknowledgement is aborted. Closing/reopening the Radix dialog content and navigating Graph→Tasks preserve its exact original body/key. A second valid same-actor command simulates another tab's newer head2. Exact original retry returns the prior receipt; the UI fetches authoritative head2 and preserves it rather than restoring head1. This covers dialog-content remount with a surviving page controller, not whole-page reload recovery.
- Hiding an active unsaved inline Status editor preserves its draft in the recovery drawer; no task PATCH occurs. Explicit discard restores persisted Status. Weekly columns appear/disappear with the selected week without automatic preference PUT. Real field archive/restore hides/reinstates its saved visible position without rewriting the preference head; the inactive choice remains checked and disabled.

Earlier attempts are preserved rather than relabeled as passes: first2 locator timeouts/6notrun (`v2-preferences-first`); second5pass/2fail/1notrun31.1s (`second`), caused by an overstrict helper expecting Reset enabled during the correctly frozen unknown-save state. The helper now asserts Reset disabled and exact Retry visible in that state. Third7pass/1fail26.6s (`third`) exposed the real rapid navigation finding below. Two targeted settled reconciliation cases then passed8.4s (`reconcile`), followed by the complete8/8 run. Original bytes/key/current-head/DB assertions were retained throughout.

**Known product finding at this frozen checkpoint:** rapid legitimate Discard→Close drawer→select Week can resurrect the old task URL and reopen the drawer. The failing trace proves Close's after snapshot at10698.728ms has no task query, while Week selection at10704.139ms produces the old task+new week+worker at10715.991ms. Exact trace `test-results/v2-preferences-third/personal-columns-Personal--5f90e-automatic-preference-writes-chromium/trace.zip`; project5bea438b-66d9-4396-bb85-319815394b27, taskd7d0b86b-4752-4b31-9c77-b3577b3c757a. This is a product stale-route-handler race, not a preference persistence failure. The settled eight-case flow explicitly waits for actual discard/closed/task-absent state; it does not clear the rapid-action finding. Coordinator assigned a source fix and deterministic regression; the original rapid browser sequence requires the next compiled checkpoint. No production source/runtime was changed during this gate.

GET-only clean Studio captures **09:50:08.830–09:50:29.933 UTC**: `workloom-evidence/v2-personal-columns/{desktop,mobile}-{table,chooser}.png`, `audit.json`. All13 chooser choices are loaded, following defaults; the dialog fits at448×772.5desktop and358×712.36mobile. No attempted writes, page errors or global overflow. The table capture uses actual loaded task rows; no preference was saved to Studio for screenshots.

#### Bounded changed-flow regression gate and window release

Six affected old flows passed together **6/6 (22.9s)** in `/tmp/workloom-v2-preferences-regression-third.log`, outputs `test-results/v2-preferences-regression-third`: P1a desktop full task/revision/subtask/filter flow and mobile read flow; P1b desktop typed custom values/history/real lock refusal and mobile number/history; P6 desktop/mobile quick add/explicit inline save/project-modal focus/Columns reachability. These cover the changed selectors and column integration; unchanged26 was not rerun.

First regression attempt1pass/2fail/3notrun41.1s (`regression`): P1a still expected a drawer from the now-quick-add section control, and both field tests measured the old last summary cell. Second1pass/2fail/3notrun17.1s (`regression-second`) confirmed that footer geometry mismatch after drawer entry was corrected. The current summary intentionally spans the whole table with its total in the first value span. Tests now measure that **actual total value**, retaining every original no-scroll clipping/viewport bound; they still check the sticky estimate header/cell and real value behavior. Shared manager uses Team columns; personal display uses Columns. No geometry assertion was removed. The geometry helper additionally polls the same actual invariant for up to5s; this does not repair the old whole-colspan selector, which still correctly failed before targeting the value.

At **09:54:03.906UTC**, all14 optimized assets remained byte/hash-identical to the before-preferences manifest, readiness database/schema `ok`; `.local/runtime/assets-after-preferences.json`. Doctor verified PG56025/API56039/Vite56187 owned/ready, worker OFF. The exclusive mainDB/compiled/browser window was explicitly released. Owned changed E2E lint passed. Root tests TypeScript at release reports only11 next-source tagId errors in the new integration test against intentionally old compiled contracts; prepared preference tests had passed before that next-source file existed. No rebuild was performed to erase that distinction. The rapid Close→Week product issue remains pending the next source/compiled gate.

### Original rapid Close→Week regression: RED before the source fix

A separate brief coordinator-approved window tested **only** the original rapid sequence against the unchanged compiled `96c8da9`/`72fbe92` production source. `rapid-time-navigation.spec.ts` performs Discard draft→Close→Week selection with **no settled-state assertion, artificial rendering delay or network throttling between those actions**. Both desktop and mobile failed at the first original sequence, before its bounded repeat cycles: **2/2 failures**, proving the defect independently of the earlier combined preference case.

Desktop route events: **10:05:57.600UTC** task query removed, **10:05:57.608** old task restored with the selected week/person. Mobile: **10:06:04.757** task removed, **10:06:04.763** restored. Exact exported JSON timelines: `workloom-evidence/v3-rapid-before/{desktop,mobile}-route-timeline.json`. Original traces: `test-results/v3-rapid-before-actual/rapid-time-navigation-Rapi-{907fc,fc73b}-esurrecting-the-closed-task-chromium/trace.zip`; log `/tmp/workloom-v3-rapid-before-actual.log`. An initial QA collector hook had an unsupported first-argument pattern and collected no tests or fixtures; `/tmp/workloom-v3-rapid-before.log` preserves that distinct harness failure.

At **10:06:39.338UTC**, all14 frozen assets remained unchanged and database/schema readiness was `ok`; `.local/runtime/assets-after-rapid-red.json`. The brief window was explicitly released. Only uniquely created original-workspace QA fixtures were written; Studio remained read-only. TaskUX owns the source route-handler correction, which still requires the same rapid cases to pass after a separate compiled/runtime gate. Prepared board/tag and meeting-discussion cases were not executed in this RED window.

### Checkpoint9460856: board/tag, meeting discussion and rapid-navigation correction

Coordinator source gates: all-workspace build, global lint/boundaries (320files), localization audit (186files/2473calls/2425English messages), all normal workspace/root TypeScript, and a clean full web **86suites /507cases PASS78.86s** (`/tmp/workloom-next8-web.log`). Independent Codex source review reported no actionable router/focus finding and did not run tests. This current-source clean run does not rewrite the earlier436/437 history.

Controlled normal helper restart **10:12:22.167–10:12:46.001UTC** preserved all **56 public tables /19,166rows** exactly in READ ONLY REPEATABLE READ snapshots, including Studio and existing preferences. No migration/seed/restore occurred. PG78136 started13:12:31 Asia/Nicosia, API78150 at13:12:32, Vite78203 at13:12:33; all owned/ready, worker OFF. Private `.local/runtime/v3-{before,after}-restart-20261016.json`. New strict tag-filter GET smoke200 at **10:13:13.313UTC** used existing original-workspace data, zero writes.

All14 optimized HTML/JS/CSS assets were verified at **10:12:42.862UTC**. Entry `/assets/index-DRK6rLqE.js`,779,429bytes,SHA256 `5e9b83ed79acb154b3fc3ce0b77d0e7f304b1eadf0db138c499e0e688efcc4e4`; `.local/runtime/assets-before-board-meeting.json`. No other owner changed dist/runtime during the gate.

#### Complete eight-case browser gate

Second complete run **8/8 PASS23.8s**, log `/tmp/workloom-v3-board-meeting-second.log` (created10:16:48.755,last output10:17:12.874UTC), outputs `test-results/v3-board-meeting-second`. The first attempt preserved **4pass/2fail/2notrun2.3m**, `first`: both meeting cases used exact label text that includes a wrapped select's options. A separate actual GET-only probe proved label matches0 versus enabled accessible combobox matches1; only the outcome selector changed to its actual role/name. No timeout, payload, permission, draft, persistence or retry assertion was relaxed.

- Board pagination uses **one unique original-workspace fixture of exactly101tasks**, shared by both sizes and read-only after API setup. Native client limit100/real opaque cursor yields100+1 with truthful partial/full loaded counts and no silent cap. The101 consist of97 AND matches plus four deliberate tag/status/participant/search exclusions. Board and table show the same97 matching titles; actual query parameters contain every selected filter. Selecting filters sends no write. Private completed manifest `.local/qa/board-pagination-cycle20261016-v3.json`; an incomplete setup fails closed rather than silently creating another fixture.
- Board status uses the real seen revision. Enforced unfinished predecessor produces real422 `DOMAIN_VALIDATION_FAILED` with unchanged task/status lane. A genuinely committed lost acknowledgement retries identical bytes/key once across Table/Board and filter disappearance; one revision persists. A held real commit produces no optimistic lane move and its late acknowledgement preserves the selected view, search draft and focus. A real isolated allowlisted viewer session sees cards with no Change status action and sends no browser write. This is not browser actor-switch/revocation coverage.
- Meeting Discussion retains actual duration, selected attendance row/person, partial outcome/minutes and attendance comment draft across sibling tabs and a genuinely committed held comment's close/reopen. Late acknowledgement preserves Attendance selection/focus. The actual literal multiline comment persists after reload; meeting metadata and every unconfirmed attendance/worklog remain unchanged, with no browser meeting/attendance write. The same stored feed is readable without a composer in a real viewer context. Studio receives no comments for tests or screenshots.
- **The original rapid Close→Week cases are genuinely RED→GREEN:** both failed before the build, then passed unchanged on desktop/mobile after the source correction. There is no settling assertion between Discard/Close and week selection, no injected delay/throttle, and four bounded immediate close/week repeat cycles per size also pass. This resolves the previously recorded rapid-route finding at this checkpoint.

Additional GET-only Studio checks **10:17:30.136–10:17:34.459UTC** cover immediate Close→Board and Close→Graph plus Week→Person and Person→Week in both empty/selected directions. Selected values, unrelated parameters and the hash survive; no closed task locator returns. Both sizes: zero writes/errors/global overflow. Exact route timelines and six outcomes per size are in `workloom-evidence/v3-rapid-extended/audit.json`. These checks do not edit Studio.

#### Settled frames and a newly found mobile board limitation

Five GET-only frames **10:18:43.944–10:18:48.848UTC**, `workloom-evidence/v3-board-meeting/`: `desktop-board.png`, `mobile-board.png`, `mobile-board-next-lanes.png`, `desktop-meeting-discussion.png`, `mobile-meeting-discussion.png`; exact URLs/metrics in `audit.json`. Studio Board has all12 actual tasks across four lanes; meeting frames use an already-created original QA task's stored literal comment, four tabs and loaded content. No attempted writes, page errors or HTTP failures.

**These are not all visual passes.** Desktop Board and both meeting frames have no global overflow. The clean Studio mobile Board has **284px global overflow** (document674 vs viewport390), despite its actual lane scroller correctly measuring358client/1252scroll pixels. The focused QA fixture populated only early lanes and missed this case. Studio's populated later Done lane exposes screen-reader-only absolute Due labels escaping a non-positioned scroll container. A separate ephemeral DOM-style diagnostic setting that scroller to `position:relative` reduces284→0; that is diagnostic evidence, **not a production fix or compiled pass**. TaskUX owns the source containment correction, which requires real populated-later-lane geometry after a future build. Original failed metrics/frames remain intact.

At **10:21:30.599UTC**, all14 optimized assets remained unchanged and readiness database/schema was `ok`; `.local/runtime/assets-after-board-meeting.json`. Doctor confirmed PG78136/API78150/Vite78203 owned/ready; worker OFF. The exclusive window was released. Owned E2E lint passed. Old-tab upgrade is still **untested**: a genuine retained-page/lazy-route probe is planned for a separate build transition, not inferred from these new pages or a post-reload result.
