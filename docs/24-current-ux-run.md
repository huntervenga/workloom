# Workloom daily UX run — 16 October 2026

Status: active. This is a new run; [12](12-active-run.md) and [11](11-implementation-progress.md) retain their historical provenance.

The authorized window is **2026-10-16 07:36:38–15:36:38 UTC**, ending **18:36:38 Asia/Nicosia**. The objective is a polished everyday task and weekly workflow, English UI copy held in JSON localization catalogs, and durable local synthetic users/tasks and database startup. This is local synthetic use. Existing domain safety rules, unknown-outcome retries, current authorization and immutable accounting remain in force.

Model policy: **Codex gpt-6.1-sol, high**. No Claude calls or probes are authorized for this run. The source checkpoint at handoff is `7e1c6da`.

## Ownership and change windows

| Area | Owner |
| --- | --- |
| Coordination, final scope, visual acceptance, runtime windows | root |
| Localization manager, catalogs, app shell, dependency/package ownership | v2_localization |
| Task table, task drawer, fields, dependencies, scheduling UX | v2_task_ux |
| Weekly planning, meetings, imports and MCP surfaces | v2_feature_ux |
| Browser acceptance, verification ledger, runtime helper and local operations guide | v2_quality_ops |

Contributors share one working tree. Preserve other edits. Builds, API restarts, migrations, seed/demo writes and mutating browser tests wait for an explicit coordinated window. The initial audit is read-only. No migration is currently expected. Existing demo and historical fixtures must survive; do not initialize or restore over the recovered cluster.

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

Initial audit evidence and ranked findings are in [25](25-ux-verification.md). Record each actual gate there, including initial failures and fixes. A skipped or blocked check is never a pass. Do not claim browser, authorization, old-tab compatibility or durable restart from a build or root HTTP status alone.

## Demo and data hygiene

GET inventory at the initial audit found one accessible workspace, **183 active projects**, and six synthetic memberships (owner, admin, three members, viewer). Many projects are prior E2E/compatibility fixtures. Do not delete or archive them to make screenshots cleaner. The approved additive **Workloom Studio** workspace now contains two English projects and 18 purposeful tasks, using the existing six actors. Its exact repeatable setup and stable entry links are in [27](27-synthetic-demo.md). The original workspace and historical fixtures remain intact.

The existing reference project is `f477730b-57dc-418f-a46b-0eeab30f8212` in workspace `5eed0000-0000-4000-8000-000000000201`. [21](21-local-pilot-handoff.md) contains its preserved walkthrough. Its Russian user-authored names are existing data, separate from UI localization completeness.
