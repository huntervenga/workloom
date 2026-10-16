# Server task due sorting

This bounded backend change adds one optional task-list sort mode. Source verification is complete; actual PostgreSQL execution, normal compiled verification and frontend/browser acceptance are separate pending gates. The endpoint and shared MCP contract accept the mode; this document does not claim a user-facing sort control is integrated.

## Contract

`GET /api/v1/workspaces/:workspaceId/tasks` and local MCP `search_tasks` accept the existing query plus optional scalar `sort: "manual" | "due_asc"`.

- Omitted `sort` and explicit `manual` retain `(position ASC, id ASC)` order. Manual is removed before canonical hashing, so the existing absent-sort normalized query hash and version 1 cursor bytes remain unchanged.
- `due_asc` sorts the entire filtered project in PostgreSQL by `(due_date ASC NULLS LAST, id ASC)` before applying the page limit. Equal dates and undated tasks use canonical UUID order. This is not a sort of the client’s loaded page.
- Existing filters intersect unchanged: project, section, status, active participant, own task tag, literal title/description search and archive inclusion. Parent tags are not inherited. The shared query remains strict; multiple sorts, descending modes, arbitrary columns and additional ordering settings are rejected.
- Existing page sizes remain default 50, minimum 1 and maximum 200. The repository fetches `limit + 1`, decorates only that bounded result and the domain returns at most `limit`. The query hash still includes `limit`; changing it requires a fresh first page.

The HTTP route already parses and forwards `taskListQuerySchema`. The local MCP input, SDK discovery schema and authorized facade use that same query, so no alternate authorization or sorting implementation is introduced.

## Cursor compatibility and authorization

Version 1 remains the strict signed manual payload with `position` and `id`. Version 2 is exclusively the due-date payload with `dueDate` (a real date in years 0001–9999 or explicit null) and `id`. Their strict signed shapes do not accept the other mode’s anchor. Version 2 retains the existing HMAC, process-key lifetime, 15-minute TTL and 2048-character token limit.

Every cursor binds workspace, actor, permission epoch and the complete normalized query. The due query includes `sort: "due_asc"`; explicit manual is equivalent to omission. Cross-sort, cross-filter, cross-limit, actor, workspace and permission-epoch reuse is rejected. A sort/filter change therefore starts a new pagination sequence. Current read authorization and project/section/status/tag ownership validation keep their existing precedence before cursor decoding. Local MCP retains current credential and membership validation inside its authorized read snapshot.

The dated seek predicate accepts later dates, same-date higher IDs, and all null dates. A null anchor accepts only null-date rows with higher IDs. This covers date ties, the transition to undated tasks and subsequent undated pages without gaps or duplicates for an unchanged task set. As with the existing live manual list, cross-request pagination is not a historical snapshot: concurrent edits to sort keys can move tasks across pages, and callers should refetch after edits.

## Persistence and performance boundary

No migration, schema change, stored sort preference or new data write is included. Existing task filters keep the workspace/project restrictions and `EXISTS` participant/tag predicates, preserving tenant isolation and one projection per task. The existing `tasks_project_position_idx` has a workspace/project prefix usable for candidate filtering; PostgreSQL may sort the matching project rows for due mode. A bounded returned page is not a bound on all database work. No large-project latency or index-backed due seek claim is made. A dedicated `(workspace_id, project_id, due_date, id)` index would require separately justified workload evidence and a reviewed migration.

## Source verification

The source-alias Vitest runner passed 161 cases across five affected suites: shared task contracts, domain task service, DB task cursor codec, HTTP task routes and the actual MCP SDK handlers. A no-emit source-alias backend TypeScript check, including the prepared integration test, and ESLint on all owned TypeScript files passed. These checks wrote no repository build/dist output and did not use PostgreSQL.

The literal legacy token test uses a fixed token generated independently by the original codec from `git show HEAD:packages/db/src/tasks/cursor.ts`, with the original fixed secret and clock. The domain test separately asserts the literal pre-sort canonical query hash input and cross-readable manual/omitted cursors. Version 2 tests cover date/null round trips, impossible dates, unsupported versions, mixed/extra keys, canonical IDs, tampering, instance keys and expiration.

[The prepared PostgreSQL integration test](../tests/integration/task-due-sort.test.ts) uses the existing validated disposable child-database helper, fails for missing or unsafe test configuration, and never falls back to the application database. Its cases cover complete server order beyond the first manual page; equal-date IDs; year 0001/9999; dated-to-null/null-to-null boundaries; 205 rows with page sizes 1, 2 and 200; filter intersections and inactive participants; access-before-cursor rejection; binding rejection; legacy manual compatibility; real HTTP and authorized MCP facade pagination; and all-public-table digest invariance across those read paths. The test file is source-prepared and has not yet been executed.

Normal build/types/lint, actual PostgreSQL results, frontend behavior, authenticated browser flows and retained old-tab upgrade checks must be recorded independently by the coordinating run. See the existing [API requirements](04-api-and-integrations.md) and [local MCP boundaries](20-p5b-mcp-contract.md).
