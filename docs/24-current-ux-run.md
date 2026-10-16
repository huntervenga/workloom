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
| Pending | Durable startup/shutdown verification | Not run |
| Pending | Final visual review and delivery | Not run |

Initial audit evidence and ranked findings are in [25](25-ux-verification.md). Record each actual gate there, including initial failures and fixes. A skipped or blocked check is never a pass. Do not claim browser, authorization, old-tab compatibility or durable restart from a build or root HTTP status alone.

## Demo and data hygiene

GET inventory at the initial audit found one accessible workspace, **183 active projects**, and six synthetic memberships (owner, admin, three members, viewer). Many projects are prior E2E/compatibility fixtures. Do not delete or archive them to make screenshots cleaner. A separate clean, English synthetic workspace/project is the preferred additive demo direction; its exact actor count and setup must be coordinated with the fixture allowlist and root before writes.

The existing reference project is `f477730b-57dc-418f-a46b-0eeab30f8212` in workspace `5eed0000-0000-4000-8000-000000000201`. [21](21-local-pilot-handoff.md) contains its preserved walkthrough. Its Russian user-authored names are existing data, separate from UI localization completeness.
