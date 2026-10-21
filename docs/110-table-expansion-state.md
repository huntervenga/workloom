# Personal table expansion

Workloom remembers table disclosure choices in the current browser. Opening a project starts with its task trees collapsed unless this person previously expanded them. Sections and assignee groups start expanded unless this person collapsed them. A child that has its own children keeps its independent choice when its parent is temporarily collapsed.

Click a section, assignee group or subtask disclosure normally. The choice is saved immediately; there is no extra Save button. Reloading the page, returning from another view, renaming the company address or reordering/renaming a section does not reset that choice. Creating a subtask still opens its parent so the new row is reachable; this explicit opening is remembered too.

Preferences are personal to the signed-in actor, workspace UUID and project UUID. Another account, another workspace or another project has its own defaults. The browser stores only internal task IDs and group keys, never task titles, descriptions, people names or field values. This is browser-local presentation state, not a project setting shared with teammates or synced across devices.

The versioned `workloom.table-expansion.v1:` record stores expanded task exceptions and collapsed group exceptions. No preference is written merely by opening or refetching a view. Filtered or unloaded tasks are not mistaken for deleted tasks, so narrowing a filter does not erase saved choices. Retention is bounded to 5,000 task exceptions and 1,000 group exceptions per actor/project; reaching a cap evicts the oldest exception. Invalid or unknown-version records fall back to the defaults without being rewritten. Disabled/full browser storage leaves the current page usable in memory. Clearing that site's browser storage restores the defaults.

## Tasks shared between projects

The ordinary table and the linked-task table use one page-owned expansion controller. Toggling a linked task therefore cannot overwrite the saved choices for native tasks, and vice versa. Linked rows retain canonical task IDs and display their loaded parent/child hierarchy under the target placement's section. A collapsed section applies consistently to both presentations. A filter or a partial page can show a child independently while its parent is not loaded; it does not invent or change a parent relationship.

The linked table displays the same selected ordinary custom columns as the native table, reading values through the target project's existing field API. Loading/unavailable values remain visibly different from an unset value, and explicit zero remains zero. This display is read-only; existing canonical detail/status and placement controls retain their original command identities. Board lanes and canonical status behavior are unchanged.

## Verification scope

Focused hook tests cover defaults, reload, nested exceptions, independent identities, uppercase UUID key identity, partial/empty task loads, corrupt records, disabled/full storage, StrictMode writes and bounded retention. Real `TaskTable` tests cover nested disclosure plus section remount behavior. Linked-table tests cover remount, shared-controller merging, target-project field reads and unchanged Board/placement commands. Existing page tests exercise sorting, grouping and retained-command behavior with explicit expansion before child actions.

The isolated six-file persistence/page regression set passed **76/76 tests**. Scoped ESLint and the isolated browser source typecheck passed. A separate compiled private Chrome run passed **2/2 cases** without retries or skips, using signed synthetic Auth and a throwaway PostgreSQL-backed API. It exercised real native/linked hierarchies, reload persistence, same-task project isolation and zero task-domain mutations from disclosure changes. The provider was closed after the run.

These checks do not confirm main-workspace browser state, a real-provider login or production deployment. The coordinating task records local activation separately.
