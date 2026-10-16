# Single-tag task filter

Bounded backend slice, 16 October 2026. Related: [task contracts](../packages/contracts/src/tasks.ts), [domain service](../packages/domain/src/tasks/service.ts), [repository](../packages/db/src/repositories/task-repository.ts), [local MCP contract](20-p5b-mcp-contract.md).

`GET /api/v1/workspaces/:workspaceId/tasks` accepts one optional scalar `tagId` UUID. MCP `search_tasks.input.query` uses the same schema and domain list command. IDs canonicalize to lowercase. Missing `tagId` stays absent in the parsed query; no default/null is injected. Repeated/array tag IDs, `tagIds`, invalid UUIDs and unsupported sorting remain validation errors.

The task must own the selected tag through `task_tags`; parent/child/package membership never inherits it. Matching children may appear without their parent, and matching parents do not pull in untagged children. The filter intersects existing project, section, status, active participant, literal text-search and archive filters. Ordering remains `(position, id)`. Correlated `EXISTS` scopes tag rows to the task and workspace, so tag/participant combinations do not multiply tasks or shared package projections. The existing `(workspace_id, tag_id, task_id)` index serves this query; there is no migration.

Current workspace authorization and project/section/status checks precede tag lookup and cursor decoding. The supplied tag must exist in the authorized workspace; a missing or foreign tag returns `NOT_FOUND`. Archived owned tags remain valid read filters because their existing task assignments are retained. This does not change assignment policy for archived tags.

Cursor version 1 and its `(position, id)` position stay unchanged. The existing canonical parsed-filter digest includes a supplied `tagId`, rejects cursor reuse across tags or tagged/untagged lists, and retains the old digest when `tagId` is absent. Current actor and permission epoch bindings stay in force. Task mutation schemas, payload hashes and receipts are untouched.

## Verification of source

Affected contracts/domain/db/API/MCP source and the integration test passed TypeScript `--noEmit`; scoped ESLint and `git diff --check` passed. Documentation relative links resolve. All checks used source aliases and produced no build output.

The focused source-alias Vitest run passed 143 tests across [contracts](../packages/contracts/src/tasks.test.ts), [domain](../packages/domain/src/tasks/service.test.ts), [HTTP parsing](../apps/api/src/http/task-routes.test.ts) and [actual MCP SDK handlers](../apps/mcp/src/server.test.ts). This includes canonical scalar parsing, unchanged untagged parsed shape/hash, manually constructed old v1 cursor acceptance, cross-tag rejection, current authorization/reference checks before a bad cursor, archived tag reads and unchanged existing MCP search/write cases.

[PostgreSQL acceptance](../tests/integration/task-tag-filter.test.ts) passed eight source-backed tests using real Fastify injection, domain commands, SQL and the MCP facade. Coverage includes pagination without task duplication; AND intersections with active/removed participants; no ancestor inheritance or hidden-parent inclusion; shared package identity/estimate preservation; archive controls; missing/foreign/archived tags; revoked current membership before cursor decoding; literal pre-filter v1 digest and signed cursor acceptance; HTTP invalid query rejection; defensive malformed UUID handling; MCP tagged pagination, cross-tag rejection and unfiltered compatibility.

The caller created only `workloom_tagfilter_20261016_1251_a48c_test`, checked that public schema was empty before migrations and additive synthetic seeding, then dropped that exact owned database. A subsequent `pg_database` query found zero databases with that exact name. The test requires an explicit `TEST_DATABASE_URL`, a restricted `workloom_tagfilter_*_test` name and an empty schema; it never falls back to `DATABASE_URL` or creates/drops databases itself.

No compiled artifact, saved runtime process, worker or main development database was changed by this slice. Source tests and PostgreSQL checks do not establish compiled browser UI, authenticated real-Auth flows or old-tab browser upgrade coverage; those remain separate acceptance gates for the orchestrator.
