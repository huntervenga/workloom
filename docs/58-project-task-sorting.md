# Project task due sorting

Project Tasks and Board have one native **Sort** control: **Manual** or **Due date**. The URL records only the explicit due mode as `sort=due_asc`. Omitted/manual, unsupported, empty or repeated sort values safely select Manual; mount does not rewrite the URL. Explicit choices use the existing authoritative router query updater and preserve unrelated parameters, week/person/task context and the hash. Back/Forward and a fresh page mount restore the URL choice. Actor/workspace/project authorization still comes from the current session and route owners, never from URL-injected identity fields.

Sort is independent of task filters and their count. Clear filters does not change sort. It does not write task positions, personal column preferences, shared configuration or local storage. Contextual Graph/Import/weekly-toolbar cleanup is a separate slice; this change does not alter those controls.

## Server pages and presentation

The task-list caller passes sort explicitly in its server query input. `normalizeTaskFilters` retains `due_asc`, while omitted/manual preserve the legacy request and cache identity. Unsupported runtime values still reach the strict schema and fail rather than becoming successful manual requests. The existing normalized infinite-query key includes the due mode. A changed query starts with `initialPageParam: null`; manual and due cursor sequences cannot mix. Cached data belongs only to its exact actor/workspace/project/filter/sort/limit query. Existing writes still invalidate task-list queries normally.

The [server contract](57-server-task-due-sort.md) orders the entire matching project by own due date ascending, undated last, then canonical task ID before applying a page limit. This is why an earlier matching task is not left behind a manually ordered first page. It does not mean the first visible grouped row is the globally earliest task.

Table preserves canonical section order, parent links and cycle ownership. It establishes that hierarchy with the existing Manual logic, then orders root/sibling lists by their own due dates; an early child is not promoted above its parent and no subtree minimum date is invented. Assignee groups keep their existing group order and flat per-task membership, sorting rows within each group. Undated tasks follow dated tasks, with task ID ties matching the server.

Board status lanes keep their canonical order. The page deduplicates current task heads and explicitly sorts those heads by the same due comparator before passing them to the existing Board. A newer duplicate that changes a due date therefore cannot retain its obsolete first-array position. Manual retains the existing tree/group positions and Board input order, without position writes.

A due first page may contain a child before its parent. The existing honest parent-not-loaded presentation remains until a later authorized loaded page supplies the parent, after which the canonical tree rejoins it. Every task still appears once; the original raw draft/session and current outside focus remain intact. No parent fetch is added. Group/descendant collapse state, Graph selection, loaded-only counts, custom columns and package-deduplicated budgets retain their existing meanings. Descendant disclosure is now held by the actor/workspace/project page owner, so a cold sort query or Board round trip cannot reset it when Table unmounts; standalone callers keep the prior local fallback. Hidden-child recovery uses the same canonical visible-task helper, without a second hierarchy algorithm. There are no group effort allocations or authoritative project/period totals inferred from pages.

## Retained editors and focus

Changing sort invalidates the current inline presentation generation immediately and includes normalized sort in the page's shared inline/completion focus scope. Retained quick, inline, rich, hours and field controllers remain page-owned. Hiding a task on a different first page keeps the existing recovery path; pending and unknown writes still retry their exact original body/key/revisions. A sort change does not clear an independent draft or convert it into a new command.

A late pre-sort acknowledgement may reconcile its exact submitted session but cannot close a newer editor, return focus into another presentation or reopen/expand a view. Remounted editors reuse their existing focus claim. The existing current-head and outside-interaction leases remain authoritative; sort introduces no timer/frame guessing.

## Verification

Source-only verification passed 134/134 cases across 11 affected suites (69.73s, one worker), source-aliased web TypeScript noEmit and scoped ESLint. The new coverage comprises 15 actual ProjectPage cases, three query cases and three pure ordering cases. Existing table, Assignee/Section grouping, tag query, Board, completion-focus and shared estimate suites remain green.

The first query regression was RED because normalization discarded `due_asc`; it is retained in `/private/tmp/due-ui-before-red.log`. The initial query/pure/presentation suite subsequently passed 16/16. A forced cold-query regression independently reproduced lost descendant collapse before the page-owned disclosure bridge (`/private/tmp/due-ui-collapse-red.log`), then passed unchanged after that bridge. The final cases include strict runtime query values, legacy manual identity, intersecting filters/cursor reset, canonical parent/cycle ownership, null/date ties, duplicate Board heads, URL restoration/defaults, same-turn Sort/Week and Close/Sort navigation, parent-arrival draft retention, descendant/Board round trips, hidden-child recovery, exact held retry and late acknowledgement.

Final source logs: `/private/tmp/due-ui-final-tests.log`, `/private/tmp/due-ui-final-tsc.log`, `/private/tmp/due-ui-final-lint.log` and `/private/tmp/due-ui-final-audit.log`. JSON, local links and whitespace are verified in the freeze manifest. Compiled browser/mobile layout, actual signed backend cursors and real server writes remain separate parent-controlled gates. Source tests use fake APIs and perform no application database/runtime writes.

Related contracts: [assignee grouping](50-assignee-grouping.md), [section disclosure](45-task-section-collapse.md), [retained drafts](44-retained-task-drafts.md), [shared estimate](54-inline-team-estimate.md), [completion focus](52-completion-focus-recovery.md).
