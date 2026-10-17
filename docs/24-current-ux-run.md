# Workloom daily UX run — 16 October 2026

Status: active. This is a new run; [12](12-active-run.md) and [11](11-implementation-progress.md) retain their historical provenance.

The authorized window is **2026-10-16 07:36:38–15:36:38 UTC**, ending **18:36:38 Asia/Nicosia**. The objective is a polished everyday task and weekly workflow, English UI copy held in JSON localization catalogs, and durable local synthetic users/tasks and database startup. This is local synthetic use. Existing domain safety rules, unknown-outcome retries, current authorization and immutable accounting remain in force.

Initial model policy: **Codex gpt-6.1-sol, high**, with no Claude calls or probes authorized at handoff `7e1c6da`. A later explicit user instruction allowed Claude for separate work; the attempted separate CLI review failed OAuth before a model call, so no Claude review is claimed. QA work here remains Codex.

## Ownership and change windows

| Area | Owner |
| --- | --- |
| Coordination, final scope, visual acceptance, runtime windows | root |
| Localization manager, catalogs, app shell, dependency/package ownership | v2_localization |
| Task table, task drawer, fields, dependencies, scheduling UX | v2_task_ux |
| Weekly planning, meetings, imports and MCP surfaces | v2_feature_ux |
| Browser acceptance, verification ledger, runtime helper and local operations guide | v2_quality_ops |

Contributors share one working tree. Preserve other edits. Builds, API restarts, migrations, seed/demo writes and mutating browser tests wait for an explicit coordinated window. The initial audit was read-only; no migration was initially expected. Later additive migrations have separate explicit gates in the ledger. Existing demo and historical fixtures must survive; do not initialize or restore over the recovered cluster.

## Starting runtime and database

At handoff the compiled API listened on `127.0.0.1:4310` (PID 6770, terminal session 67143), Vite on `4311` (session 44214), and native PostgreSQL 17.5 on `127.0.0.1:55432` (PID 7471). These are observations, not permanent process identifiers.

The cluster now lives at ignored `.local/postgres/data`; it was recovered after reboot at 07:30:21 UTC. `.local/postgres/recovery-20261016.verified.json` records all 54 public table counts and canonical full-row digests matching the prior verified backup. `.env` was preserved with mode 0600. Credentials are never copied into tracked documents. Queue contents/worker operation and application workflows require separate checks. The worker begins OFF.

The private `.local/postgres/README.md` contains the current exact-cluster restart instructions. Root approved a bounded `scripts/local-runtime.mjs` doctor/start/stop helper and [26](26-local-runtime.md): existing cluster only, no implicit build/migrate/seed/restore, verified process identity and helper ownership before stop, fail closed for unknown ports or stale PIDs. Runtime execution still requires the coordinated window.

## Phase ledger

| UTC | Phase | Actual state |
| --- | --- | --- |
| 07:36:38 | Run begins | Eight-hour window authorized |
| 07:40:56.609–07:41:10.796 | Initial desktop/mobile audit | Six GET-only surfaces captured; zero attempted writes, zero page errors, no global horizontal overflow |
| 08:17:24.241 | Initial UI/localization checkpoint | Authors frozen; real JSON-only locale/draft smoke passed and temporary locale removed |
| 08:17 | Controlled verification preparation | Read-only P0 shell 6/6 passed; full mutating browser/API gate waits for root build/runtime window |
| 08:20:01.258–08:21:38.126 | Controlled durable restart | Helper start/doctor/stop/start/doctor passed; all 54 tables / 11,480 rows preserved exactly |
| 08:39:26.296 | Frozen compiled browser checkpoint | Full 26/26 pass; all 12 served assets unchanged from the pre-suite manifest |
| 08:39:35.113–08:39:39.804 | Additive synthetic workspace | 82 commands acknowledged; all 54 tables / 14,647 pre-existing rows preserved exactly |
| 08:41:50.031–08:42:23.805 | Final clean-workspace frames | Ten GET-only desktop/mobile surfaces, zero errors/attempted writes/global overflow |
| 08:43:29.401 | Exclusive checkpoint window released | Assets unchanged, helper doctor all owned/ready; next source slice has a separate gate |
| 08:54:06.592–08:54:32.026 | Second checkpoint controlled restart | All 54 tables / 15,247 rows preserved, including clean Studio data |
| 08:54:34.068 | Second compiled checkpoint `2d02bc4` | 14 served assets frozen; focused cases started with a failure cap |
| 09:01:19.485–09:01:31.968 | Settled visual correction | Loaded custom values/dependency summary; fourteen GET-only frames, zero errors/writes/global overflow |
| 09:04:22.083 | Second checkpoint window complete | One 8/8 focused run; four changed weekly cases covered passing across 3+1 runs; all 14 assets unchanged and doctor owned/ready |
| 09:11:22.163–09:11:23.673 | Fresh pre-comments backup | Custom archive + real owned-copy restore match54tables/16,835rows +11migrationrows; copy removed |
| 09:13:23.079–09:13:23.708 | Separate reviewed MAIN0011 GO | Only additive0011 applied; original54tables/16,835rows +11migrationrows preserved, new comments table empty |
| 09:14:38.684 | Third checkpoint `bbc0e53` runtime | Ownedrestart preserves55tables; newAPIreads/14assets pass |
| 09:21:57.320–09:22:04.033 | Comments/D1 visual proof | Six GET-only initial-result/literal-discussion frames; no Studio comments added |
| 09:22:24.178 | Third checkpoint window complete | First complete8/8 pass18.0s, all14assets unchanged, doctor owned/ready; source-only D2/prefs separate |
| 09:34:10.221–09:34:11.526 | Fresh pre-preferences backup | Actual owned-copy restore preserves55tables/17,177rows +12migrationrows; exact copy removed; separate MAIN0012 GO followed |
| 09:43:15.248–09:43:17.444 | Reviewed MAIN0012 | Only additive preferences migration applied; all55 oldtables/17,177rows +12migrationrows unchanged, newtable empty |
| 09:43:57.194 | Fourth runtime restart | All56 tables/17,177rows exact; owned/ready services,14assets frozen |
| 09:44:52.266–09:44:54.863 | D2 compact plan geometry | All16 plans/foursemanticcolumns; desktopmedian55px/mobile95px, actualhours1287/1383px earlier; zero writes/errors/overflow |
| 09:48:20.289 | Personal columns complete browser run |8/8 pass21.2s; prior attempts preserved and rapid Close→Week product race remains explicit |
| 09:50:08.830–09:50:29.933 | Personal columns final frames | Four settled Studio GET-only table/chooser frames;13choices, zero writes/errors/overflow |
| 09:54:03.906 | Fourth window released | Changed-flow regression6/6 pass22.9s; all14assets unchanged, doctor owned/ready; no next-source builds by QA |
| 10:05:57.600–10:06:04.763 | Original rapid Close→Week RED | Both sizes reproduce oldtaskresurrection6–8ms after Close; no injected delay or settledmask |
| 10:06:39.338 | Brief RED window released | All14frozenassets unchanged/readinessok; nextsourcefix and Board/meeting gates remained pending |
| 10:12:22.167–10:12:46.001 | Checkpoint9460856 restart | All56tables/19,166rows exact; no migration,14assets frozen, worker OFF |
| 10:17:12.874 | Complete Board/meeting/rapid browser gate |8/8 PASS23.8s secondrun; first4pass/2selectorfail/2notrun preserved; originalrapidRED→GREEN |
| 10:17:30.136–10:17:34.459 | Extended GET-only rapid navigation | Close→Board/Graph and both picker orders preserve currentroute/hash, zero writes/errors/overflow |
| 10:18:43.944–10:18:48.848 | Final settled five frames | Board12tasks/fourlanes +storedmeetingDiscussion; actualmobileStudioBoard284pxoverflow found, notallvisualPASS |
| 10:21:30.599 | Fifth runtime window released | All14assets unchanged/readinessok; ownedservicesready; mobileBoardcontainment fix nextsourcegate, oldtabuntested |
| 10:27:45.326–10:27:45.548 | Read-only worker backlog inventory | No runnable stored jobs;22 subscribed pending events, all original QA, current census complete; Studio recurrence/job scope zero; worker remains OFF |
| 10:48:12.221–10:50:24.848 | Genuine retained old-tab build transition | Original9460856 page retained across build; unloaded old Weekly chunk404, route fails; zero writes, explicit upgrade limitation |
| 10:49:54.408–10:49:55.671 | Fresh BEFORE0013 backup and actual restore | All56tables/20,280rows +13migrationrows match restored copy; exact owned copy removed, main0013 still unauthorized at this gate |
| 10:52:53.760–10:52:54.376 | Reviewed MAIN0013 | Old56tables/20,280rows +13migrationprefix unchanged; exactlyfournewemptycutofftables and14threceipt |
| 10:53:02.864–10:53:42.101 | Sixth controlled restart | All60tables/20,280rows exact; newcutoffAPIstrictGET200,14assetsfrozen, worker OFF |
| 10:58:51.218–10:58:55.461 | Compiled populated Board geometry | Five settled Studio GET-onlyframes; oldmobile284pxoverflow→0, laterDone2tasks/duelabels preserved |
| 10:59:26.453–10:59:51.760 | Complete completion/cutoff/My tasks browser gate | Final8/8PASS25.0s; priorharnessfailures preserved separately, exact logtimestamps in25 |
| 11:01:19.557 | Browser asset comparison | All14assets unchanged, readinessok; oldtabfailure remains separate |
| 11:02:00.630–11:02:19.857 | Explicit cutoff queue registration | Two→fourqueues; oldregistrations/7jobs/7receipts and60publictables/21,416rows exact |
| 11:02:42.849–11:02:43.172 | Fresh read-only worker inventory |22recurrencepending+12supersededcutoffpending, noactivecutoffgrant; Studioinvolvement0, worker OFF |
| 11:05:16.274–11:06:22.540 | Normal worker start/backlog proof |22recurrenceACK/receipts,6stalecutoffACK+6futuredeferred;57domain tables exact, Studioeffects0 |
| 11:08:27.398–11:10:00.915 | Real worker deadline/browser observation | Lastenable thenGET-onlydualviewport; deadline11:09:57.204, jobfrozen11:09:59.005,90planned/180estimated,1testPASS |
| 11:10:20.465–11:10:20.671 | Normal worker SIGTERM/drain/stop | Clean15msruntime drain, exactownedprocessabsent;6futurejobs preserved, worker OFF |
| 11:12:07.164 | Final PhaseB asset/readiness comparison | All14assets unchanged, APIready/ownedserviceshealthy; oldtablimitation separate |
| 11:23:25.977–11:26:39.110 | Managed worker-only lifecycle | Start/doctor/plain-start reuse/clean stop/OFF passed;59of60publictables exact, only discovery checkpoint changed;42jobs/sixfuturejobs and14assets unchanged |
| 11:27:41.318–11:29:02.910 | Genuine old-tab transition and explicit refresh | Retained oldWeekchunk404/genericfailure; visibleRefreshloadsnewentry/samefullURL, noautoreload orwrites; upgraded-copy separate |
| 11:30:11.376–11:30:15.686 | New compact Board Studio geometry | Desktopfirstcard342px/mobile334px; noWeek/Personbox,12actualtasks/fourlanes,0globaloverflow, allGETonly |
| 11:38:03–11:38:29 | Complete title/hierarchy/Board-context gate |6/6PASS25.6s after documented harness corrections; exact lostACK/draft/focus and actualnativeguard covered |
| 11:39:05–11:39:23 | Native guard page-error accounting |2/2PASS17.7s, realbeforeunload+dismiss/sameDoc/unsentdraft, expectedcanceledreloadtimeoutrecorded,0pageerrors |
| 11:39:59.768 | Seventh compiled window released | All14newassets unchanged, readybodies/ownedserviceshealthy, worker OFF; updated-entry detection needslatergenuinebuild |
| 11:58:27.999–11:59:46.885 | Genuine upgraded-entry transition | Retained634entry showsactualupdated-appheadingafteroldWeekchunk404; explicitRefreshloadsnewentry/sameURL, noautoreload/writes |
| 12:01:38–12:04:50 | Eighth compiled browser gate, partial |6of8acceptedacrossfocusedruns; compactstatus/completionlane-movefocusactualRED, nofull8passclaim |
| 12:03:20.376–12:03:23.706 | Studio Board320/390/1440 |12tasks/fullDue labels/localhorizontalscrolling,0globaloverflow; firstcard334/334/342px |
| 12:07:07.262 | Eighth window released |14assets unchanged/strictreadiness/ownedserviceshealthy, worker OFF; focusfixrequiresnextcompiledverification |

Initial audit evidence and ranked findings are in [25](25-ux-verification.md). Record each actual gate there, including initial failures and fixes. A skipped or blocked check is never a pass. Do not claim browser, authorization, old-tab compatibility or durable restart from a build or root HTTP status alone.

## Demo and data hygiene

GET inventory at the initial audit found one accessible workspace, **183 active projects**, and six synthetic memberships (owner, admin, three members, viewer). Many projects are prior E2E/compatibility fixtures. Do not delete or archive them to make screenshots cleaner. The approved additive **Workloom Studio** workspace now contains two English projects and 18 purposeful tasks, using the existing six actors. Its exact repeatable setup and stable entry links are in [27](27-synthetic-demo.md). The original workspace and historical fixtures remain intact.

The existing reference project is `f477730b-57dc-418f-a46b-0eeab30f8212` in workspace `5eed0000-0000-4000-8000-000000000201`. [21](21-local-pilot-handoff.md) contains its preserved walkthrough. Its Russian user-authored names are existing data, separate from UI localization completeness.

## Worker observation acceptance and current limits

The compiled completion/cutoff-control/My tasks eight-case gate passed. A separately authorized real worker run drained the known metadata-only backlog, then froze one explicitly armed new QA period after its actual deadline. One browser test retained desktop/mobile views, unsent second-person plan and independent personal-baseline report choices, refreshing only GET projections. Immutable request receipt, baseline/audit `source: job`, real queue start-after/acknowledgement and clean normal stop are recorded in [25](25-ux-verification.md). The worker is now OFF; automatic processing is not currently operating. Six future stale jobs remain stored. The original retained old tab still failed to load its missing lazy chunk; an explicit Refresh tab action now recovered the same URL on the new build. A subsequent genuine build transition now also proves the updated-app detection/copy and explicit refresh recovery; the old missing chunk remains an explicit failure before refresh. No continuous-worker or OS-reboot claim follows from this bounded run.


## Next bounded gate preparation — 2026-10-16T11:52:50.178Z

Eight cases (four flows at desktop1440/mobile390) are authored for section collapse, immutable work-type person lens, retained ordinary hours/custom-field protection and compact Board cards. Only static source checks and Playwright listing have run; no new browser, API fixture, build, restart, migration, queue or worker action is part of preparation. The current accepted compiled entry remains`index-eWPbXBeY.js`/source`634aac8`. New source implementation and these pending browser cases must not be reported as accepted runtime behavior. Details and coverage limits are in [25](25-ux-verification.md).

## Next focus/grouping and separate Graph gate — source preparation, 12:30 UTC

Prepared eight cases: unchanged compact-card desktop/mobile focus regressions, plus assignee grouping, individual applied-filter chips and command-focus leases at both sizes. A separate two-case Graph inspector gate covers workspace-wide blockers, selected-task policy, layered focus/navigation and actual node geometry. Scoped TypeScript, lint and Playwright listing cover ten cases in five files; no browser execution or fixture creation has occurred during preparation. Existing compact cases remain unchanged from the prior actual RED evidence. The compiled source remains `3caa48f`, with its two unresolved browser focus failures. The next controlled build and execution require coordinator GO; no old-tab capture is scheduled for this checkpoint. Detailed pending scope and limits are in [25](25-ux-verification.md).

## Compiled grouping/focus gate — 2026-10-16 12:32–12:34 UTC

Coordinator's normal build from product checkpoint `223b708` passed all workspace/root types, lint and797/797web cases in111suites/112.21s. QA source is committed `8df08b9`. Actual served entry is `/assets/index-uIneYcB8.js`,791,438bytes,SHA256 `6297584140080590ba97ca9809db7e4621c5ed29915a04adba246cb080e244b3`.

The primary eight-case browser gate passed **8/8 in one first run,15.5s**. The unchanged compact-card status/completion cases now provide genuine prior RED→current GREEN evidence at desktop/mobile; grouping, applied-filter chips and exact retry/focus leases also passed. The separate Graph inspector pair failed **0/2** at real node overlap: wrapped190px nodes exceed representative164px spacing by26px. Earlier on-demand/enforce/outside-root and same-project layered-focus assertions passed; later Canvas controls and cross-project navigation remain unverified. Graph geometry is an open product defect, not an accepted visual gate. Full failure history remains in [25](25-ux-verification.md).

GET-only Studio320/390/1440audit passed, firstcard334/334/342px and0globaloverflow with all12tasks/fourlanes retained. All14served assets remained exact from12:32:23.432 to12:34:11.472UTC; strict API database/schema readiness and owned PG/API/web doctor passed. Worker remains **OFF**. No migration, runtime restart, queue or worker operation occurred. Window released at12:34:11.472UTC. No old-tab probe was rerun; the prior genuine explicit-refresh result is separate. Archived logs, JSON, screenshots and failing traces: `workloom-evidence/v7-focus-graph/manifest.json`, beside the independent `v7-focus-graph-studio/audit.json`.

## Next Graph revision and Team estimate — source preparation, 12:45 UTC

Prepared four pending cases: revised Graph desktop/mobile plus inline shared Team estimate desktop/mobile. The Graph fixture keeps the original164px saved spacing, verifies the saved DTO remains untouched, invokes the actual **Apply automatic layout** in list-first state, then checks generated nonoverlap/full node text and every existing inspector focus/navigation assertion. It does not manually widen saved coordinates. Estimate cases use two fresh QA projects per viewport so a supported protected baseline for packageC cannot lock editable packagesA/B. Null/zero, shared-package footer deduplication, semantically equivalent input/no write, real lost-ACK original retry and authoritative FIELD_LOCKED with retained raw draft are required. Only scoped TypeScript/lint and four-case listing have passed; no fixture/browser/runtime/build activity is part of this preparation. The prior primary8 acceptance and separate Graph2 actual failure remain unchanged.

## Compiled measured Graph and Team estimate gate — 12:58–13:05 UTC

Product checkpoint `6ff13df` passed coordinator build/types/lint,841/841web cases/116suites129.33s,1307/1307unit cases/77suites16.71s and45/45isolated PostgreSQL cases/5suites21.07s. Actual served entry `/assets/index-CTAp7rY6.js`,792,177bytes,SHA256 `d245345375ada14514ea54724b7363efce4633328a35cbfd748716dd8d0d9ae7`.

Corrected full gate **4/4PASS15.5s**. Graph desktop/mobile passes actual measured automatic placement, full wrapped title/project/status, nonoverlap, on-demand inspector policy/focus/cross-project guard and final saved DTO/no-write conservation. Initial saved API coordinates/Save-disabled state are preserved; initial Canvas transforms were not checked. Arbitrary saved positions may overlap until explicit automatic placement. Team estimate desktop/mobile passes unknown/zero distinction, shared root/detail budget and deduplicated footer, equivalent-input no-write, real lost-ACK original retry and authoritative protected-package refusal/raw-draft retention. The first attempt had1pass/2harness failures/1notrun; exact traces and narrow setup corrections remain in [25](25-ux-verification.md).

Final GET-only existing-fixture frames13:05:08.277–13:05:12.669UTC confirm all three generated nodes inside actual1088×544desktop/358×544mobile Canvas with0writes/errors/globaloverflow. All14assets remained exact12:58:16.396–13:05:18.994UTC, strictready/ownedservices healthy, worker **OFF**. Window released13:05:18.994UTC. The API process still uses its earlier backend; these four cases use unchanged APIs and make no new due-sort runtime claim. No restart, migration, queue, worker or old-tab operation occurred. Archive `workloom-evidence/v8-graph-estimate/manifest.json` lists41hashed files. The coordinator must separately authorize the proposed controlled full-stop/start and its before/after data/queue proof.

## Controlled backend reload — 13:08:34.196–13:08:42.859 UTC

The separately assigned runtime owner completed one actual normal helper stop/start of PostgreSQL, API and web, with worker OFF. Root accepted `/private/tmp/workloom-ux8-controlled-restart-proof.json`: all60public tables/24,113rows, full catalog/indexes, all queue data including42jobs/fourqueues, PostgreSQL system/database/directory identity,14servedassets and compiled backend hashes stayed exact. New owned PG46630/API46643/Vite46683 are ready; the built due-sort backend is now loaded. Real read-only Studio12-task limit2 due/manual pages differ as expected and intersecting status/search/section/participant reads pass. The initial permission preflight failed before process control; its reviewed read-only identity check was corrected before the one actual restart. No OS reboot, worker start, migration, seed or restore is claimed. This runtime gate is separate from the pending sorting UI gate.

## Project sorting browser gate — source preparation, 13:16 UTC

Two pending cases (desktop1440/mobile390) use one shared101-task read-only-after-setup QA project and two independent six-task QA projects,113tasks total. The actual frontend page size is100, so51tasks cannot exercise its page boundary. Supported explicit manual positions put an undated120minute parent first,99dated zero-estimate roots next, and its earliest-due child last. Actual due cursor/Load more must surface the child before its later parent, then rejoin the canonical tree without duplicate budget/counts. The small fixtures cover section/sibling/null-IDties/Boardlane order, retained descendant/group collapse, native filters/Clear independently of sort, URL Back/Forward/reload, an unsent detail description and a real held root-date ACK across sort/reorder/outsidefocus. Only source-alias TypeScript, scoped lint and two-case listing have run. No fixture/browser/runtime/build action occurred during this preparation; exclusive compiled GO is still required. Current Filters details behavior is unchanged, with no auto-close-on-sort assertion.

## Compiled project sorting acceptance — 13:19–13:22 UTC

Product checkpoint `444346d` passed coordinator web build, all workspace/root types, lint and862/862web cases/119suites137.35s. The unchanged backend retains the prior1307unit/45isolated-PG gates; they were not rerun for this frontend-only checkpoint. Actual entry `/assets/index-Ddzen8Co.js`,792,523bytes,SHA256 `ca24a1fc131740e004b5efd4d4536bfbc86d56d347d24f0cab5f562faf9c0515`.

Corrected full browser gate **2/2PASS11.2s**, desktop5.4s/mobile4.6s. Both sizes verify genuine100+1due pages, a child beyond Manual's first page, actual opaque cursor/Load more, later-parent joining with package footer counted once, canonical section/sibling/null-IDtie and Boardlane order, retained descendant/group collapse, native filter/Clear independence, URL Back/Forward/reload, unsent independent child description and a real held date ACK across sort/reorder/outsidefocus. The first run's two failures were an over-specified auto-close expectation: a changed presentation intentionally retains a clean remounted editor. The corrected check requires confirmed enabled value, unchanged Search focus/URL and an explicit no-op Save with zero extra PATCH. First traces and actual scope are in [25](25-ux-verification.md).

Shared fixture key `v9` created one101-task project and stayed read-only for both runs. First/corrected independent six-task projects bring the authorized cumulative setup to125tasks/fivefresh QA projects; no cleanup or old-data/Studio mutation occurred. All14served assets remained exact through13:21:50.257UTC, strictready/owned PG46630/API46643/Vite46683 healthy, worker **OFF**. No build/restart/migration/queue/worker/old-tab action occurred in this browser window. Archive `workloom-evidence/v9-task-sorting/manifest.json` preserves both attempts, private fixture manifest, actual DTO/query/command proofs and desktop/mobile native full-page frames. The exclusive window is returned after this archive/documentation freeze.

## Contextual toolbar browser gate — source preparation, 13:31 UTC

Two cases are prepared for desktop 1440px and mobile 390px. Each uses one fresh QA project, two ordinary tasks and two explicit planning periods. The native five-view matrix checks that Tasks retains week/person, search, filters, grouping, sorting and personal Columns; Board retains search/filters/sort; Timeline retains search/filters; Graph and CSV import hide those controls. Returning to Tasks must restore the selected context and an unsaved Tags column choice without sending any save.

The same cases then test a real committed column save with a lost acknowledgement, recovery from Graph or Import, exact original retry, and modal Close returning focus to the visible active view. A separate real hours save preserves its original period/person after changing only the selected hours lens, then recovers from Timeline with the original body/key and no late focus or view change. Graph/Import frames at 320, 390 and 1440px are prepared in the zero-write matrix phase. Static TypeScript, lint and two-case listing pass; no fixtures, browser execution, build or runtime actions have occurred for this pending gate. Graph dragging belongs to a separate owner and gate.

## Compiled contextual toolbar acceptance — 13:36–13:42 UTC

Coordinator normal gates for `d97041c` passed web build, all workspace/root types, lint and 883 web cases in 120 suites (141.17s). Actual entry is `/assets/index-CzXNmADz.js`, 792,635 bytes, SHA256 `2de882dce729eb710f3f73f904345ac4c6920a07767ef0ffe7222e86d8023561`.

The corrected toolbar gate passed both cases in 8.9s (desktop 4.2s, mobile 3.5s). It verifies all five native view contexts, retained unsaved personal choice without writes, exact column-save recovery from Graph/Import with Close focus returning to the active view, and exact original hours recovery from Timeline without late focus or view changes. The first two failures were a test assumption that Tags starts unchecked; real fresh defaults were checked. Only that assumption was replaced with an actual initial-state/inverse assertion. Both original traces, the runner's maximum-failure marker and a separate launch-path typo are preserved in [25](25-ux-verification.md).

Graph/Import body tops are 197px at 1440px and 189px at 390/320px, with zero global overflow or browser writes during the matrix phase. The first desktop Graph frame still showed the lazy diagram loading; a separate existing-fixture GET-only capture waited for the real node and replaced it for visual review. All 14 assets remained exact through 13:41:59.208 UTC, strict readiness and owned services passed, worker OFF. No build, restart, migration or worker operation occurred. Archive `workloom-evidence/v10-context-toolbar/manifest.json` lists 32 hashed files. The exclusive window is returned after this documentation freeze; Graph drag and title readability remain separate owner gates.

## Inline Priority browser gate — source preparation, 13:50 UTC

Two cases are prepared for desktop 1440px and mobile 390px, each with two tasks in one new QA project. The target explicitly starts at Medium; this does not change the product's create default of None. Native choices, blur, unchanged Save and Escape retention must send no mutation. Explicit High save, a real committed Urgent response lost in transport with exact Board recovery/retry, and a final explicit clear to None permit four PATCH attempts for three accepted commands. An independent unsent description, other task fields, work-package and participant revisions must remain unchanged.

Scoped TypeScript, lint and two-case listing pass. Editing and final-state frames are prepared with zero global overflow checks. No fixture, browser, runtime or build action occurred for this source gate; the Priority action's current source integration and the separately owned title/Graph gates remain coordinator-controlled.

## Native Graph dragging acceptance — 13:44–13:51 UTC

The existing Diagram already supports native node dragging. Product source `a5f9234` adds only a localized instruction to drag a card background and explicitly Save my layout; it does not add pointer handlers, change geometry, autosave, dates or effort. This gate used the same compiled `d97041c` entry `/assets/index-CzXNmADz.js`, 792,635 bytes, SHA256 `2de882dce729eb710f3f73f904345ac4c6920a07767ef0ffe7222e86d8023561` accepted for the toolbar. Normal coordinator gates remain 883 web cases/120 suites, web build/types/lint PASS.

Three separate native-mouse attempts are preserved. First, both cases failed an incorrect total mouse-down/up delta oracle: XYFlow establishes its drag anchor after crossing the native threshold. The next attempt passed the corrected active-anchor scaled movement but failed an exact comparison of API doubles against browser-rounded CSSOM transforms. Root approved only these two harness corrections. The final run passed **2/2 in 34.1s**, desktop15.6s/mobile16.1s, without any GraphCanvas/controller change or numeric tolerance widening. Exact raw request→stored DTO checks remain separate from exact browser-serialized rendering checks.

Both final cases pass native background dragging at measured non-unit zoom, no task opening/autowrite, explicit full-set Save/reload and native root reselection, hidden saved-position retention, Discard, cross-project Stay/Leave, real committed lost ACK with pending/unknown movement locks and exact original body/key retry. Task and policy DTOs remain unchanged. The separate outward boundary fixture starts at `(99990,-99990)` and retains valid intermediate positions: desktop `(99999,-99999)`, mobile rendered `(99998.8984375,-99998.8984375)`, both explicitly saved consistently. This is not a new hard-clamp or arbitrary boundary-sequence guarantee. Mouse input at390px does not prove physical-touch usability; root selection is reselected after reload, not persisted.

All14served assets remained exact **13:44:09.910–13:50:50.750UTC**, strict database/schema readiness and helper-owned PG/API/web doctor passed, worker **OFF**. No build, restart, migration, worker/queue operation or old-tab probe occurred. The runtime window was released at13:50:50.750UTC. The permanent `workloom-evidence/v10-graph-dragging/manifest.json` preserves all three attempts, traces, staged JSON, four actual Diagram screenshots and exact asset/source provenance. Detailed first failures, oracle reasoning and coverage limits are in [25](25-ux-verification.md) and [60](60-graph-dragging.md). Title readability and inline Priority remain independent gates.

## Table guidance — source preparation, 14:08 UTC

Two native browser cases are prepared in `tests/e2e/table-guidance.spec.ts`, one at 1440px and one at 390px. They read only the existing complete title-fixture manifest `.local/qa/task-title-cycle20261016-title-v1.json`, project `b3a88290-1c7a-40f2-967b-017953c243ca`. A missing or mismatched manifest fails instead of creating fixtures. No seeding helper is imported. Browser API mutation attempts are recorded and aborted.

At future execution, real GETs must confirm the same twelve task DTOs before and after the UI interactions. The known 4h budget is checked against current package projections, counting the nine shared details once and retaining two explicit zero packages. This fixture does not exercise unknown estimates, conflicting projections or partial pages. Those remain separately owned source coverage.

The cases prepare native Enter/Space activation and focus checks for the initially closed About this table disclosure, first with Due date alone and then with Assignee plus Due date. Footer budget/counts stay visible, and toggling must retain the full URL, empty filter/search state, grouping, sort, explicit empty week, selected person and hash. An independent unsent Description survives closing its drawer and toggling the help, then is explicitly discarded without a save. Closed/open full-page screenshots and zero global overflow checks are prepared; local table scrolling remains allowed.

Source-alias TypeScript, scoped ESLint and Playwright listing pass (two cases). This is preparation only: no browser execution, API calls, fixture creation, build or runtime operation occurred. The coordinator must grant a compiled browser window before execution. Priority and the separately owned title-readability gate remain independent.

## Title, Priority and guidance gate — 14:24–14:33 UTC, partial acceptance

Compiled `0fc9feb` includes title `6359d42`, Priority `38141da` and guidance `d453f93`. Coordinator build, normal types and lint passed. Preserve both full-web attempts: default parallel execution had 932 passes and three one-second findByRole timeouts in 58.41s; the complete unchanged one-worker run passed 935 cases across 126 suites in 311.11s. This browser gate does not rerun backend unit or isolated PostgreSQL checks.

The first six-case attempt stopped after both Priority cases timed out: fresh-project defaults hide the optional Priority column. Four cases did not run. Root approved a fixture-only correction using each new QA project's own supported personal-column preference API before browser request tracking. Product defaults and every task command/draft/geometry assertion stayed unchanged. The runner's extra error is its maximum-failure stop marker. The separate corrected run finished **five passes, one genuine desktop Priority failure in 89.14s**. Original outputs are preserved.

Title passed at 1440/390 using the exact existing twelve-task fixture, including nine hierarchy levels, long/unbroken text, cross-section context and a retained draft. All twelve titles at each size have nonzero unclipped text bounds and no overlapping native controls. Native open, Graph selection and rename/no-op focus checks pass without browser writes. This is genuine prior geometry RED to corrected GREEN; physical IME remains untested. Guidance also passed both sizes: native Enter/Space/focus, initially closed conditional help, visible loaded footer, actual 240-minute deduplicated budget, unchanged context, retained raw description and exact before/after task DTOs, with zero mutation attempts.

Mobile Priority passed all planned native choices, selection/blur/no-op behavior, High save, real committed Urgent lost response and exact Board-hidden recovery, outside focus, explicit clear to None and independent description retention. Four browser PATCH attempts represent three accepted commands. Desktop reached the committed/lost Urgent response but could not activate Collapse editor: its enabled 24px control sits beneath the adjacent sticky Team estimate cell, which repeatedly intercepted pointer input. The narrow feedback panel also wraps to an excessive row height. This is a product defect; no forced click, geometry weakening or extra rerun was used. Priority is not fully accepted. Fix and a later compiled regression remain pending.

A separate GET-only Studio Product launch capture at 14:31:56.997–14:31:58.235 UTC found twelve tasks in the specified project, rather than the eighteen-task workspace-wide recipe count. Both settled 1440/390 frames show twelve unclipped title boxes, zero global overflow, a loaded 39h 30m budget from actual DTOs, separated title/action controls and local mobile table scrolling. Task DTOs remain exact; no writes, failed HTTP responses or page errors occurred. The initial count-only probe stopped before page navigation and is preserved separately.

All fourteen served assets stayed exact from **14:24:23.957 to 14:32:48.046 UTC**, entry `/assets/index-DQLsdq9t.js`, 792,798 bytes, SHA256 `8f37cb2df85bc2e8672578afe08a134357462261fe36e1b01ff424a069fe82ec`. Strict database/schema readiness and owned PG46630/API46643/Vite46683 doctor pass; worker OFF. No build, process control, migration, worker action or old-tab probe occurred. Runtime/browser window released at 14:32:48.046 UTC. Permanent evidence is `workloom-evidence/v12-table-complete/manifest.json`; Studio frames and audit are also under `workloom-evidence/v12-studio-table/`. Existing data and partial QA fixtures remain preserved.

## Compiled `54005e1` inline layout and personal-columns gate — 14:49–14:51 UTC

Chronology: model policy at handoff permitted no Claude calls, and the first separate Claude CLI review failed OAuth before any model call (above). Later explicit user authorization let Claude author the inline-editor layout fix `2b386a6` and the personal-columns recovery `54005e1`. Their source-only histories stay in [65](65-inline-editor-layout.md) and [64](64-personal-columns-recovery.md), including the CLI command-permission blocks that prevented the authoring sessions from observing a RED run for the columns fixes. The V12 results above are unchanged.

Root's normal gates for compiled HEAD `54005e1` passed: web build, all workspace/root types and global lint, plus **954 web cases in 128 suites in 306.75s** with maxWorkers 1. The localization audit counted 206 sources, 2,634 calls and 2,591 English messages. Logs are `/private/tmp/workloom-v13-normal-{build,types,lint,web}.log`. Backend `6ff13df` results (1,307 unit/77 suites, 45 isolated PostgreSQL/5 suites) were not rerun.

The browser window with fixed assets ran **14:49:57.057–14:50:53.111 UTC**. The original six cases (Priority, title and guidance, each at 1440/390) passed in **18.5s**. Desktop Priority now passes the same native Collapse click after a real committed Urgent response with a lost ACK. The V12 sticky-overlay failure stays recorded as the prior RED. Four new personal-columns cases (two flows at 1440/390) passed in **9.5s**: a real concurrent 409, then Discard holding a current-head refresh that blocks stale edits, then Save at the fresh revision; and a delayed real 409 after Close and Board, with visible closed feedback and an explicit Graph reopen that keeps the draft without automatic writes. Native 403/503 recovery is not claimed and remains source coverage.

All 14 served assets stayed byte-identical during the window. Entry `/assets/index-CqaV_uR0.js` is 793,355 bytes, SHA256 `3887d847e3edd927563b75b481a7e0e222b173ae5e63cf55e5a10ba4090d6ed8`. Readiness reported database/schema ok, doctor reported owned/ready PG/API/Vite, and the worker stayed **OFF**. There was no restart, migration, seed or production action. The old-tab gate was not rerun; its earlier separate result stands. No V13 archive exists: automatic permission review rejected an optional extra local copy, so `v13-claude-recovery` was not created. Original logs and browser results stay at their existing paths. The V12 archive is unchanged. Details are in [25](25-ux-verification.md).

## V14 inline editor reveal — RED 14:59–15:03 UTC, GREEN 15:03–15:05 UTC

Root's stronger read-only geometry gate measures without scrolling, focusing or clicking. On old compiled `54005e1` it failed natively at both 1440 and 390, before any further click or save. On desktop a sticky cell occluded Priority, More details and Collapse; on mobile the select reached x=425. All 14 assets were unchanged 14:59:28.015–15:02:52.463 UTC. The V13 six-case pass stays valid, but it never asserted unassisted initial visibility.

Source `5267fbd` reveals an explicitly opened editor once inside its own table scrollport ([65](65-inline-editor-layout.md)). Root's normal gates on it passed, including **955 web cases in 128 suites in 331.48s**. Using the same spec hash as the RED, the six stronger cases passed at 1440/390 in **33.2s**. Root inspected the Priority screenshots: the select and the action buttons are visible. Assets were byte-exact 15:03:53.573–15:04:51.583 UTC with the worker OFF.

Test-only `4e63b57` then added a 1024×900 Priority case with a read-only sticky-cell check. It passed 1/1 in 5.1s on the final spec; an earlier intermediate-spec run had also passed, despite its `-red` log name. No product change was needed. Compiled product `5267fbd` is the latest accepted checkpoint. The independent source review was still running at that point. No V13/V14 archive was created. Details are in [25](25-ux-verification.md).

## V16 column recovery and visible footer — RED by 15:22 UTC, GREEN 15:23–15:25 UTC

The independent read-only review finished. It found no inline-editor issue and reported three P3 column-recovery scenarios. Source `5af56a8` keeps a draft's original revision on ordinary or access-recovery reloads, allows reads during a held save without resetting it, and makes denial copy neutral ([64](64-personal-columns-recovery.md)). Its author observed RED, then GREEN on 34 cases.

Footer `ef5f5b0` keeps the loaded budget inside the table's visible width ([63](63-table-guidance.md)). Root's focused tests passed 13 cases. The enhanced guidance spec `35ec787` adds a real-wheel horizontal stage. Its final frozen version failed natively at 1200 and 390 on old compiled `5267fbd`. The two earlier attempts include desktop harness gaps that are not product REDs.

On compiled `35ec787`, the normal gates passed, including **959 web cases in 128 suites**. The seven native table cases passed in **22.7s** with the same guidance spec hash as the RED. Root viewed the scrolled screenshots and saw the budget and labels at the far right. The four real-409 personal-columns cases passed in **8.9s**. All 14 assets were byte-exact 15:23:11.235–15:24:45.908 UTC with the worker OFF.

The read-only re-review found all three P3 findings resolved, with no new blocking issue. `35ec787` is the latest accepted checkpoint, and source is frozen. 403/503 and the direct reload race were untested natively at that point. Details are in [25](25-ux-verification.md).

Test-only `6099cea` then added a jsdom flow for the reload/pending-save race. Root's three personal-columns suites passed 35/35, and types and lint passed. There was no build, browser run or full-suite rerun ([25](25-ux-verification.md)).

## Handoff — 16 October 2026

- **Code.** The accepted compiled checkpoint is `35ec787`. The later commit `6099cea` changes tests only. Product source is frozen.
- **Runtime.** The helper-owned PostgreSQL, API and Vite were ready at the last gate. The worker is **OFF**, and six stale jobs remain stored. Automatic deadline processing is therefore stopped ([43](43-managed-local-worker.md)).
- **Team guide.** [66](66-team-quick-start.md) is current.
- **Rules.** The working rules in `AGENTS.md` are unchanged. No extra evidence archives were made, and secrets, `.env`, `.local` and database contents stay excluded.
- **Not done.** Real Auth, private ACL, a full Asana migration, external calendars, physical touch/IME and production are outside accepted scope. Native 403/503 and the reload race remain untested natively.
- **Window.** The requested window is 07:36:38–15:36:38 UTC. Root records the final git, link and runtime checks and the actual completion separately.

## V18 Asana-like table editing — accepted on compiled `5ca0487` (17 October 2026)

The run after `35ec787` added the stable grid and direct cell editing (`c3ca2ce`). Root then committed every agent fix as code commit **`5ca0487`** (38 files). The contract is in [68](68-asana-table-editing.md), and the demo is in [67](67-asana-style-demo.md).

The path to GREEN went through these REDs and rejected runs, all preserved in [25](25-ux-verification.md):

- an initial source RED for fluent entry;
- the first 30-case compiled run: 22 passed, 3 stale-head 409s, 5 did not run;
- a direct-after-ACK RED (3 failed);
- a 39-case pre-`5ca0487` run with 37 passed and 2 failed, where an error popover occluded Open;
- an initial full web run with 1,025 passed and 1 failed;
- an intermediate full web run with 1,049 passed and 1 failed, not accepted.

On `5ca0487`, every root gate passed:

- build, lint/boundaries/localization and types;
- **1,050 web cases in 137 suites**;
- **39/39** native cases in 1.3 minutes;
- focused recovery, 3/3;
- the read-only demo and explicit-week geometry checks.

The doctor check passed for PostgreSQL, API and web. The worker stays **OFF** as an optional component. There was no runtime restart or new migration. Auth, old-tab upgrade and the backend (1,307 + 45) were not rerun, since no backend files changed.

## Handoff — 17 October 2026

- **Code.** The current accepted bounded local UX is compiled code commit `5ca0487`. `35ec787` is now the previous checkpoint, and its gates stand as recorded above.
- **Not done.** Physical touch/IME, Safari, native 403/503, real Auth/private ACL, full Asana migration and production are outside accepted scope.
- **Links.** Runtime links contain no IDs in these docs. Root provides them to the user directly.

## Night first UI checkpoint — 17 October 2026, accepted `5708be0`

Root accepted compiled code **`5708be0`** for the first night milestone's 103 source paths. Later live-refresh/change-head files and app wiring are outside this checkpoint; [70](70-workspace-live-refresh.md) remains **PROPOSED**. The behavioral contract and root matrix are in [69](69-night-daily-ux.md), with the full evidence ledger in [25](25-ux-verification.md).

- **Source gates.** Full build, global lint/boundaries/localization and root types passed before the final mobile title style fix. After that fix, final web build including web `tsc` and ESLint on 93 changed TypeScript files passed. No global-check claim covers the later phase2 working tree.
- **Frozen web.** 1,216 passed in 155 suites, 365.74s.
- **Backend and database.** Backend unit: 1,321 in 79 suites, 23.63s. Real PostgreSQL original-estimate oracle: 8 in 7.51s; pure oracle: 4 in 99ms, not PG cases. Separate planning/cutoff/field-policy PG regressions: 16 in 3 suites, 13.55s.
- **Compiled native.** New frozen night 25/25 in 1.6min; unchanged legacy Asana 39/39 in 1.6min; legacy meeting/time-context 4/4 in 33.2s. These are **68 distinct cases**. The earlier focused connector pair is included in the final 25, never added again.
- **Preserved failures.** The earlier mixed/interim full-web failures, hover/label harness failures and real mobile title/action overlap RED remain in 25. The title fix reserves actual action width in flow. A review P1 on cached original estimates after 403/404 was fixed with primed-cache regressions. Quota/error responses are not completed reviews.
- **Actual demo.** Four read-only views had zero writes/errors/overflow: saved plan 94h, baseline fact 84h 45m, all fact 88h; known original 121h versus current loaded 123h.
- **Runtime, separate.** An API-only restart at 00:22:01.655 UTC conserved that snapshot's 60 public tables/31,305 rows and unchanged digest, preserved PG/Vite identities and left worker OFF. This predates later additive QA and is not current inventory or an OS-reboot gate. Doctor passed.

`5ca0487` remains the previous accepted checkpoint. Old-tab upgrade, real Auth/private ACL, physical touch/IME, Safari and production were not rerun or claimed. Source, compiled browser, PostgreSQL, runtime and old-tab evidence remain separate. There is no accepted cross-client synchronization claim from this milestone.
