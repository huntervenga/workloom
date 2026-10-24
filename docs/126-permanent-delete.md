# Permanent delete of tasks and projects

Archive stays the everyday action. A permanent delete removes the rows for good and is for cleaning up after a bad import or a test project.

## What it does

- `POST /api/v1/workspaces/:ws/projects/:id/purge` with `{ "confirmName": "<exact project name>" }` and `POST /api/v1/workspaces/:ws/tasks/:id/purge` with `{ "confirmTitle": "<exact task title>" }`. Owner or admin only; a wrong name or title is refused (400).
- Everything that depends on the removed project or task goes with it, found from the database's foreign keys: subtasks, field values and their history, placements in other projects, tags, dependencies, sections, statuses, fields, import records, saved reports and so on. A project takes every task homed in it; tasks of other projects that were only linked into it stay.
- Replay receipts that name a removed project or task are deleted too, so a later import with the same keys creates fresh rows instead of being answered with a deleted entity.
- Immutable history tables reject deletes through user triggers. The purge switches those triggers off only for the tables that lose rows, inside its own transaction (a failure rolls everything back, including the switch), and switches them on again before commit.
- Each purge writes one workspace audit event (`purged`) with the name or title and the number of rows removed per table.

## Operator command

```sh
node scripts/purge.mjs project --workspace-id UUID --project-id UUID --confirm "Exact project name" --yes
node scripts/purge.mjs task    --workspace-id UUID --task-id UUID    --confirm "Exact task title" --yes
```

Local database only. Without `--yes` it prints what it would do. Take a `pg_dump` first: there is no undo.

## Re-importing after a purge

The Asana importer keeps a journal and a source-project claim under `.local/imports/`. After purging an imported project, move that source project's journal directory and claim file out of the way (do not delete them) before importing it again. Imports stay bound to those files, not to the database.

## Verified

Integration test `tests/integration/purge.test.ts` (task with subtasks, project with tasks and an untouched neighbour, refusal for member/viewer and unknown ids). A rehearsal on a scratch copy of the local database and the real clean re-import of weeks 42 and 43 on 24 October 2026. There is no screen for it yet: the API and the operator command are the only entry points.
