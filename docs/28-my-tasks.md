# Workspace-wide My tasks

The personal inbox reads current tasks across every project in the selected workspace. It derives the person from the trusted actor and their current workspace membership. The client does not enumerate projects, choose a membership, or infer an authoritative total from loaded pages.

## Read contract

`GET /api/v1/workspaces/:workspaceId/my-tasks` accepts only these filters:

| Filter | Values and default |
| --- | --- |
| `relation` | `all` (default): responsible or active participant; `assigned`: responsible; `participating`: active participant |
| `completion` | `open` (default): todo/in-progress; `closed`: done/cancelled; `all` |
| `includeArchived` | `false` (default); `true` includes archived tasks and projects |
| `search` | Trimmed literal substring in task title or description, maximum 200 characters; `%`, `_`, and backslash remain literal |
| `limit` | Integer 1–200, default 50 |
| `cursor` | Opaque, signed continuation for this exact normalized query |

The response contains an existing task DTO and current project/status labels for each row, plus explicit `meta.nextCursor` (string or null). Those labels and task titles are stored content; localization does not rewrite them. Existing task HTTP/MCP contracts stay unchanged.

## Authorization and consistency

Each page runs in one PostgreSQL `REPEATABLE READ READ ONLY` transaction. Current workspace authorization (`task.read`, including an active viewer), permission epoch, joined task selection, and batch task decoration share that snapshot. Authorization runs before cursor decoding/use. The read path invokes no mutation runner, workspace barrier, planning guard, cutoff, recurrence materialization, idempotency receipt, audit, or outbox write.

SQL limits selection to `limit + 1` (at most 201) before decoration. Workspace/project/status predicates and an active-participant `EXISTS` avoid cross-workspace reads and participant multiplication. The existing batch task reader decorates the bounded IDs; there is no per-row query or project enumeration cap. This slice adds no schema migration or database index.

Rows sort by due date ascending, null last, then task ID. A distinct signed `my-tasks` cursor binds its kind/version, workspace, actor, membership, permission epoch, every normalized filter (including limit), and the last due date/ID. It expires after 15 minutes. Old task cursors, changed filters, forged/expired cursors, or changed permission epochs require reloading the list; a cursor never grants access.

Each individual page is consistent. Separate pages do not form a retained database snapshot: concurrent task/date/access changes can move rows between pages. The client deduplicates loaded IDs, labels its count as **tasks loaded**, and offers refresh. It makes no claim of an exact total or complete snapshot during concurrent edits.

## Client behavior

The sidebar opens `/w/:workspaceId/my-tasks`. Filters are local to this mounted page and reset after leaving and returning; URL/saved-filter persistence is future work. Search applies on form submission. Query keys include actor, workspace and filters. Returning to the page refetches, including after task edits.

Rows open the existing project route with `?task=<id>`, preserving the existing guarded task drawer. The inbox itself is read-only. A failed/denied page hides previously loaded rows and uses the established privacy-safe error copy. English JSON labels use the normal localization runtime, including date formatting; stored task/project/status text remains verbatim.

## Verification

Source-alias verification was used while the compiled local API remained frozen for the preceding QA window; it does not modify package `dist` or restart the API.

- Contracts: strict defaults/filters, decoration identity and explicit pagination metadata.
- Domain: authorization order, self-derived membership, viewer access, complete cursor binding and bounded page selection.
- Cursor: authentication, expiration, legacy-kind rejection, exact payload shape, IDs and calendar dates.
- HTTP: trusted identity, strict filters, current denial and absence of a write endpoint.
- Web: cross-project rendering without project enumeration, verbatim stored labels, submitted filters, deduplication and hiding stale rows after denial.
- PostgreSQL: six passing integration cases on owned disposable databases cover more than 500 projects; responsibility/active participation; completed/archive filters; actual `%`, `_`, and backslash escaping; same-date/null-date keyset boundaries; current denial before bad cursors; permission-epoch invalidation; actual read-only/repeatable-read settings; concurrent-update snapshot consistency; and unchanged task/identity/planning/receipt/audit/outbox/workspace data across reads.

Final compiled-build and browser acceptance are reported separately in [the current UX verification record](25-ux-verification.md). This source-level evidence alone does not certify that the frozen API serves the new endpoint.
