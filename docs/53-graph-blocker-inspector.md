# Graph blocker inspector

Status: source-only candidate, 16 October 2026. This extends the accepted [P4a dependency UI](17-p4-contract.md) with a bounded read-only inspector. The compiled checkpoint remains `3caa48f`; this document does not claim browser, visual, old-tab or production acceptance.

## User behavior

Every diagram node and accessible Graph task card offers **View blockers (N)**. Its accessible name includes the task title. Opening it reads only that selected task through the existing `GET /tasks/:taskId/blocking?limit=10` hook. Rendering the Graph does not read blocking details separately for every node. The button count is the Graph snapshot; the dialog replaces it with the current blocking response's full count and explicitly labels the loaded row count separately.

The small dialog identifies the selected task and each returned predecessor's title, project and status. Tasks returned outside the current Graph node-ID set have **Outside this graph**. Archived tasks and projects are labeled; cancelled and archived predecessors remain in the returned unfinished set. Only the done status group resolves a predecessor. **Load more blockers** follows the existing signed cursor; **Refresh blockers** and error recovery restart from the first page. A fresh authoritative zero says **No unfinished predecessors at the latest check**. Missing, malformed or failed reads never imply readiness.

Policy text comes from the selected task's returned blocking summary, including when its project differs from the Graph's project. Warn explicitly allows status changes. Enforce explains that start and completion are blocked while predecessors remain unfinished, with other fields editable. A returned current-status violation is explained without changing the task.

**Open task** uses the existing Graph callback with the returned `TaskDto`. A same-project drawer opens above the inspector; closing the drawer returns focus to that row's Open task button. Cross-project navigation uses the existing departure guard. Choosing Stay retains the inspector and unsaved layout; explicitly leaving proceeds to the other project's task. The inspector has no dependency, task or policy write controls and is available to viewers.

## Access, scope and input boundaries

One query is keyed by actor, workspace and selected task using the existing dependency query keys. Every returned page must identify that task. Closing A and opening B cannot display A's late response. Actor/workspace/project changes and Graph root/depth changes close and clear the selection. If a successful Graph refresh removes the selected task, the inspector closes.

A failed read, including a failed later page, hides all cached predecessor details and offers **Restart blocker list**. Access denial enters the existing Graph-wide hidden-data boundary. The denied task read is retained even if roots or Graph nodes change. **Check graph access** must successfully reread graph/layout/policy and that blocking query before exposing the Graph again. A late access-check result from another actor/workspace/project/task cannot clear the current denial.

Diagram controls are native buttons with a minimum 24px hit height and `nodrag nopan`; pointer-down, key-down and double-click propagation is stopped. They do not move a node, create a dependency or open a task. Close/Escape use the existing shared DialogShell focus behavior. If the original button has been removed by a Graph refresh or access boundary, that disconnected DOM element cannot receive focus; no replacement target is invented here.

Graph roots, neighbor depth, layout writes, edge drafts/retry and policy editing retain their existing behavior. This feature changes no API, contract, backend or database code.

## Source verification

Passed with source aliases and no build or emitted output:

- 11 focused inspector cases: selected-only read, warn/enforce and authoritative pagination count, inside/outside/cross-project/archived/cancelled rows, viewer read-only controls, fresh zero, Escape/Close focus, failed cursor/cache hiding/restart, repeated access denial and explicit reauthorization, missing/mismatched response, delayed A/B, actor reset and refreshed-node removal, real Canvas event handlers, same-project layered drawer focus and cross-project Stay/Leave guard.
- All dependency suites plus the existing localization regression: **46 cases / 8 suites**.
- All-web source-alias TypeScript `--noEmit`; scoped ESLint; localization audit; `git diff --check`; local links below.
- All **795 compiled files** across web/API/worker/contracts/UI/domain/DB remained hash-identical to `/private/tmp/workloom-graph-blockers-frozen-dist.json`.

Commands: `./node_modules/.bin/vitest run --config /private/tmp/workloom-graph-blockers-vitest.config.mts src/features/dependencies src/features/tasks/localization.test.tsx`, `./node_modules/.bin/tsc -p /private/tmp/workloom-task-ux-source-tsconfig.json --noEmit`, scoped `eslint --max-warnings=0`, and `node scripts/check-localization.mjs`. Temporary Vitest and TypeScript configurations alias contracts directly to source and do not rebuild libraries. The final owned-source inventory is `/private/tmp/workloom-graph-blockers-source-manifest.json`.

Initial focused run had nine passes and two test-environment failures: ReactFlow hides unmeasured jsdom nodes, and the memory-router harness lacks the real data-router departure guard. The corrected test exposes only the measured-node visibility seam and uses the app's actual guard/data router for navigation. No product regression was fixed by weakening an assertion. jsdom event coverage does not establish actual drag/pan geometry, touch behavior or screen-reader behavior.

Real desktop/mobile diagram/card checks (including tall wrapped nodes against the existing 128px layout height and 36px gap), pointer geometry, authenticated flows, compiled assets and old-tab upgrade coverage remain separate coordinator gates. No live browser, API, database, migration, worker or runtime operation was performed for this source candidate.

Implementation: [GraphView](../apps/web/src/features/dependencies/GraphView.tsx), [GraphCanvas](../apps/web/src/features/dependencies/GraphCanvas.tsx), [GraphBlockers](../apps/web/src/features/dependencies/GraphBlockers.tsx), [focused tests](../apps/web/src/features/dependencies/GraphBlockers.test.tsx), [English catalog](../apps/web/src/i18n/locales/en/dependencies.json), and the two narrow compatibility values in the [existing localization fixture](../apps/web/src/features/tasks/localization.test.tsx). Current runtime/browser evidence remains in [25](25-ux-verification.md).
