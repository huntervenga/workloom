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
| English catalog completeness and namespace consistency | Owner gate passed | Foundation audit: 158 files / 2,274 calls / 2,213 English messages; JSON-only browser proof below |
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
