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
| English catalog completeness and namespace consistency | Pending | No result yet |
| Build, types, lint and affected web tests | Pending | No result yet |
| Existing browser workflows, desktop/mobile | Pending coordinated write window | No result yet |
| GET-only final desktop/mobile screenshots and geometry | Pending | No result yet |
| Startup helper fail-closed identity checks | Pending | No result yet |
| Existing database persistence and helper start/stop | Pending coordinated runtime window | No result yet |
| Old-tab upgrade behavior | Not tested in this run | Must be reported separately |
| Real Auth/private ACL/production | Outside this local synthetic scope | No claim |

## Project-list data hygiene

Initial GET inventory: one accessible workspace, **183 active projects**, six synthetic memberships. Prior test projects remain present and must be preserved. A clean additive demo is preferable to deleting history. A seventh synthetic actor needs a coordinated allowlist/fixture decision; inserting an arbitrary user would not create a valid selectable dev identity.

## Gate log

No candidate acceptance gates have run yet. Append exact commands, timestamps, counts, actual failures and corrections here. Do not sum overlapping test-suite counts.

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
