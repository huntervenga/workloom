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
| 10:53:02.864–10:53:42.101 | Sixth controlled restart | All60tables/20,280rows exact; newcutoffAPIstrictGET200,14assetsfrozen, workerOFF |
| 10:58:51.218–10:58:55.461 | Compiled populated Board geometry | Five settled Studio GET-onlyframes; oldmobile284pxoverflow→0, laterDone2tasks/duelabels preserved |
| 10:59:26.453–10:59:51.760 | Complete completion/cutoff/My tasks browser gate | Final8/8PASS25.0s; priorharnessfailures preserved separately, exact logtimestamps in25 |
| 11:01:19.557 | Browser asset comparison | All14assets unchanged, readinessok; oldtabfailure remains separate |
| 11:02:00.630–11:02:19.857 | Explicit cutoff queue registration | Two→fourqueues; oldregistrations/7jobs/7receipts and60publictables/21,416rows exact |
| 11:02:42.849–11:02:43.172 | Fresh read-only worker inventory |22recurrencepending+12supersededcutoffpending, noactivecutoffgrant; Studioinvolvement0, workerOFF |
| 11:05:16.274–11:06:22.540 | Normal worker start/backlog proof |22recurrenceACK/receipts,6stalecutoffACK+6futuredeferred;57domain tables exact, Studioeffects0 |
| 11:08:27.398–11:10:00.915 | Real worker deadline/browser observation | Lastenable thenGET-onlydualviewport; deadline11:09:57.204, jobfrozen11:09:59.005,90planned/180estimated,1testPASS |
| 11:10:20.465–11:10:20.671 | Normal worker SIGTERM/drain/stop | Clean15msruntime drain, exactownedprocessabsent;6futurejobs preserved, workerOFF |
| 11:12:07.164 | Final PhaseB asset/readiness comparison | All14assets unchanged, APIready/ownedserviceshealthy; oldtablimitation separate |
| 11:23:25.977–11:26:39.110 | Managed worker-only lifecycle | Start/doctor/plain-start reuse/clean stop/OFF passed;59of60publictables exact, only discovery checkpoint changed;42jobs/sixfuturejobs and14assets unchanged |
| 11:27:41.318–11:29:02.910 | Genuine old-tab transition and explicit refresh | Retained oldWeekchunk404/genericfailure; visibleRefreshloadsnewentry/samefullURL, noautoreload orwrites; upgraded-copy separate |
| 11:30:11.376–11:30:15.686 | New compact Board Studio geometry | Desktopfirstcard342px/mobile334px; noWeek/Personbox,12actualtasks/fourlanes,0globaloverflow, allGETonly |
| 11:38:03–11:38:29 | Complete title/hierarchy/Board-context gate |6/6PASS25.6s after documented harness corrections; exact lostACK/draft/focus and actualnativeguard covered |
| 11:39:05–11:39:23 | Native guard page-error accounting |2/2PASS17.7s, realbeforeunload+dismiss/sameDoc/unsentdraft, expectedcanceledreloadtimeoutrecorded,0pageerrors |
| 11:39:59.768 | Seventh compiled window released | All14newassets unchanged, readybodies/ownedserviceshealthy, workerOFF; updated-entry detection needslatergenuinebuild |
| 11:58:27.999–11:59:46.885 | Genuine upgraded-entry transition | Retained634entry showsactualupdated-appheadingafteroldWeekchunk404; explicitRefreshloadsnewentry/sameURL, noautoreload/writes |
| 12:01:38–12:04:50 | Eighth compiled browser gate, partial |6of8acceptedacrossfocusedruns; compactstatus/completionlane-movefocusactualRED, nofull8passclaim |
| 12:03:20.376–12:03:23.706 | Studio Board320/390/1440 |12tasks/fullDue labels/localhorizontalscrolling,0globaloverflow; firstcard334/334/342px |
| 12:07:07.262 | Eighth window released |14assets unchanged/strictreadiness/ownedserviceshealthy, workerOFF; focusfixrequiresnextcompiledverification |

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
