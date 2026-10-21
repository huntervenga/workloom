# Reusable Asana project import

Import one matching JSON and CSV export pair into an explicitly selected local Workloom workspace. The reusable adapter discovers the common source project from all exported root memberships, preserves canonical Asana task IDs across projects, and reuses previously confirmed private member aliases and duration-field decisions. A project name, filename or teammate name is never used to identify a task or person. Task identity always remains its source GID.

Use `$workloom-asana-import` with the export pair and target workspace to run this workflow. Its [skill instructions](../.agents/skills/workloom-asana-import/SKILL.md) call this same method; no separate import algorithm is maintained.

For the owner-only local browser workflow, see [Projects → Import from Asana](111-local-asana-upload.md). It calls this same method; the guide records availability and recovery limits separately from activation evidence.

## Method and CLI

The executable method is exported by `scripts/import-asana-project.mjs`:

```js
import { importAsanaFiles } from './scripts/import-asana-project.mjs';

const result = await importAsanaFiles({
  mode: 'plan', // Use 'apply' for the same reviewed input and journal.
  workspaceId: '<target workspace UUID>',
  jsonPath: '/absolute/path/export.json',
  csvPath: '/absolute/path/export.csv',
});
```

The equivalent reusable CLI is a **`files` subcommand**:

```sh
node scripts/import-asana-project.mjs files --plan \
  --workspace-id '<target workspace UUID>' \
  --json '/absolute/path/export.json' \
  --csv '/absolute/path/export.csv'
```

Use Node24, the repository working directory and its existing private local/shared environment. `files --help` is read-only and requires neither database credentials nor source files. This is a local operator, not an anonymous HTTP import endpoint; it accepts only the managed local PostgreSQL target, or the isolated synthetic test target when tests explicitly enable it. Production database transfer remains separate work.

The method can accept `mappingPath`, `journalDir` and `sourceProjectId` when automatic discovery is insufficient. The default durable directory is `.local/imports/asana-projects/<workspace UUID>/<source project GID>/`. Known mappings come from owner-private `mapping.json` files under `.local/imports/`; explicit `profileRoot` exists for isolated tests. Conflicting saved decisions stop the operation. Pending people can match exact persisted mailboxes; the source owner and changed mailboxes require a prior human-confirmed private alias. No Auth account, browser session or invitation is created.

The first project imported with the [older explicit operator](107-local-asana-snapshot-operator.md) retains its original journal and receipt format. The new method refuses to recreate that same source project in a different journal. Resume an existing legacy import with its original explicit operator and files; do not bypass the guard by inventing a new namespace.

## Optional preserved representations

Unsupported data is not silently dropped. The default preparer rejects these cases unless the caller explicitly chooses a supported representation:

- `unsupportedSubtypePolicy: 'preserve_as_task'`, CLI `--preserve-milestones`: an exported milestone becomes an ordinary Workloom task. Its original subtype remains in the source provenance and the plan reports the conversion count. This does not add a native milestone task type.
- `unresolvedDependencyPolicy: 'preserve'`, CLI `--preserve-external-dependencies`: dependency labels whose targets have no ID in the paired JSON remain in provenance and are counted as unresolved. No guessed native edge is created. Ambiguous labels matching multiple exported task names still stop the import.

Timed task dates remain unsupported. Missing source comments, attachments and activity history cannot be reconstructed. Native creation/history records describe the actual import; original source timestamps remain provenance rather than fabricated historical events.

## Safe task reuse

The source namespace remains `asana:<source workspace GID>`. Existing tasks are reused by their external source GIDs; titles are never deduplication keys. Before creating a target project, the method compares every shared task's canonical title, description, hierarchy, assignee, completion, calendar dates, tag identities and current mapped home-field values, including missing versus explicit zero. Existing scalar-field IDs come from the accepted import mapping. For a legacy enum absent from that scalar mapping, a unique current home-project definition with the original name/type and matching option values is a compatibility check; an unavailable, renamed or ambiguous definition stops the import. This is not task identity matching. Conflicts stop before domain writes. A new child under an already-existing parent in another home project currently requires explicit composition and is rejected before project creation.

A reused task receives an active placement in the new project. The canonical task, home-project fields, package and original reference vectors are not rewritten. The new project's ordinary field definitions receive values under that active placement. Those are **project-local fields**, not new canonical task copies. Authorization, planning cutoffs, locks, revision checks, policy usage and immutable field-value history still run through the ordinary domain commands.

Source tags reuse verified GID-to-native-tag mappings from previous applied import artifacts. A same-name tag without source identity is a conflict, not permission to merge unrelated tags. Existing tags are not renamed or recolored by the import.

The operator retains complete source rows, including reused-task provenance, in immutable staged source snapshot artifacts and in the owner-private original export archive. These snapshot artifacts intentionally remain `staged`; they are archival source material and must not be represented as newly applied task batches. Only new tasks are applied through the unchanged public CSV importer's 50-row bound.

## Reports and dates are optional user configuration

A report is created only when explicitly requested through the method's `report` option, or CLI `--report`. It uses source field GIDs already explicitly mapped to `current_estimate` and `current_actual` duration fields. It does not recognize English field names, manufacture a planning baseline or infer a mandatory week.

```js
{
  projectDates: { from: '2026-10-12', to: '2026-10-18' },
  report: {
    name: 'Plan and fact',
    hierarchy: 'root_tasks',
    capacityRange: { startDate: '2026-10-12', endDate: '2026-10-18' },
  },
}
```

Equivalent flags are `--project-from`, `--project-to`, `--report-name`, `--report-hierarchy root_tasks|all_tasks`, `--capacity-from` and `--capacity-to`. Both endpoints of each range are required. Report/date options are schema-validated before the first domain write. Root-only scope matches a table whose section sums exclude expanded children; choose all tasks when parent and child values should both be counted. Missing values retain their coverage state, and configured zero remains zero.

A capacity range reads existing person schedules and approved absences. The importer does not invent employment dates, schedules or leave settings. Unknown capacity stays unknown.

## Current visible limits

Reused tasks appear in the existing separate **Linked tasks** block. Its target-project custom fields are displayed read-only; editing those target fields through the linked row or canonical task drawer is outside this bounded import. The ordinary field API/operator can edit them while their placement remains active. Canonical status is shared between projects.

The selected **project report** includes both home and linked tasks and reads that project's own field values. **Workspace reports** retain canonical home-project attribution and deduplicate task IDs. Therefore a workspace report selecting only the newer linked project omits tasks whose home source is not selected; it does not silently substitute another project's metric values. Selecting both home projects counts each canonical task once, using its home configuration. Use the imported project's own report to compare its complete Asana snapshot.

## Failure and resume

The complete import is **resumable, not one database transaction**. Every domain write is journaled with its exact body/key before invocation, and every owner/member mapping is rechecked. Project resources, source archives, bounded new-task applications, placements, field values and optional reports have separate checkpoints. Before its first domain write, the operator atomically retains a private source-project claim under `.local/imports/.source-project-claims/`, binding the workspace/source identity to the canonical journal path, reviewed plan digest and owner. Planning only checks existing claims; it creates none. This also blocks a different journal with changed options after an early committed write whose response was lost. Keep these claims alongside the journals; deleting local recovery files defeats this local operator guard. A failure leaves an explicit partial project; retry the original pair, options and durable directory. Do not switch journals to hide a failure.

Fresh reconciliation verifies the complete project rows, source identities, sections and sibling order, canonical fields, tag IDs, typed field values, null/missing/zero distinctions, options/colors, original source provenance, native resolved dependency edges, totals, table columns and optional report task count/sums. Shared home data is read again to prove it stayed unchanged. Only zero differences produce a `verified` result.

For multiple projects, invoke the same method sequentially for each pair, retaining each default journal. Review an ambiguous source project, new identity, conflicting shared task, unsupported hierarchy or unresolved representation before proceeding. Batch import does not imply permission to import unrelated files or publish anything.

## Verification

```sh
node --test scripts/asana-import-files.test.mjs scripts/import-asana-project.test.mjs
node --import tsx --test scripts/asana-import-files.integration.test.mjs
```

The integration uses only an owned throwaway PostgreSQL child. It imports one legacy snapshot, then a second project with shared roots/children and new rows, tests lost responses after project creation, task application, placement creation and a target field value, including refusal of a changed plan under an alternate journal before any source archive exists, checks exact replay and different-journal refusal, preserves original canonical rows/fields/references, and verifies report totals. It also checks pre-write conflict/mixed-home hierarchy rejection and no fabricated worklogs, baselines, original-estimate observations, meeting attendance, shared activities, comments or employment profiles.


## Actual local week 41 receipt — 21 October 2026

The local Balancy import completed and freshly reconciled at **16:58:49.532 UTC**, with zero differences. [Open week 41](http://127.0.0.1:4310/app/w/balancy/projects/e0d65b56-8948-4e29-9d35-d8e1ffa1b01c) or its [saved root-only report](http://127.0.0.1:4310/app/w/balancy/projects/e0d65b56-8948-4e29-9d35-d8e1ffa1b01c/reports?report=3db4500d-4f3a-40de-845c-2a2ad63544f8). The existing workspace owner and pending members were reused; their accounts and invitations were not replaced.

| Verified result | Count or value |
| --- | --- |
| Project cohort | 87 tasks: 58 roots, 29 children |
| Canonical task writes | 65 new tasks; 22 existing tasks reused through placements |
| Project configuration | 4 sections, 10 tags, 3 ordinary custom fields |
| Status/assignment | 63 done, 86 assigned |
| All-task estimate / fact | 153h / 119h |
| Saved report scope | 58 root tasks; estimate 90h / fact 82h |
| Project-local value rows | 158 |
| Unresolved representations | 1 milestone preserved as ordinary task; 3 external dependency labels retained in provenance, no guessed edges |

The root-only report deliberately excludes child values to avoid silently counting parent and child estimates together. The all-task totals are a separate reconciliation scope. Capacity remains unknown when real employment/schedule profiles are absent; no schedules were inferred from task dates or source hours.

An independent after-check found **2 projects, 170 canonical tasks, 192 active placements, 170 task source references, 298 field-value rows, 1 saved report and 195 command receipts** in this imported cohort. All previous week 42 hashes matched: 105 tasks, 140 values, 105 references, its project, 5 sections, 3 fields, 3 enum options and its column-setting row. The 22 shared tasks retained their canonical home data. Eight checked work/history/accounting source tables remained empty: no fabricated worklogs, planning baselines, original-estimate observations, meeting attendance, shared activities, comments or employment profiles.

Exact replay of week 41 returned the same project/report at **16:59:17.455 UTC**, again with zero differences. Its durable private journal and source-project claim were retained. The original explicit week 42 operator also replayed at **17:00:07.010 UTC**, retaining its 105-task project with zero differences; the legacy journal was not replaced. Entity and receipt counts remained unchanged across both exact replays.

### Activation and verification scope

Controlled local activation completed at **16:58:29.747 UTC**, before the import. Backup: `.local/backups/asana-bulk-926a81c6-d9cd-47e9-996b-90642eb83c62`. Migration 0029 retargeted exactly three field-value/history/policy-usage task FKs to retained project placements; all 107 tables, old rows/catalog, environment files and the previous migration-ledger prefix were preserved, ledger 29→30. PostgreSQL and Vite were retained, only API restarted, worker OFF. All 560 non-HTML resources and both HTML entrypoints were verified. The runtime doctor then passed for all three owned services. Final activated-source parity passed; 39 verification-evidence files were retained under the private backup.

The final global/check/build passed. Node unit coverage passed 2,372 tests / 147 files; importer unit 9 and isolated PostgreSQL fault/resume 1 passed. Field-placement checks passed 68 unit / 5 files and 22 PostgreSQL / 5 files, including populated upgrade preservation, active-placement checks, detached receipt replay denial and late-fault rollback. Table-state focused web checks passed 76 / 6 files and private compiled native browser checks passed 2 / 2 without retries or skips; see [110](110-table-expansion-state.md). These scopes overlap and must not be summed into a distinct-case total. The earlier broad-web RED remains historical; this checkpoint does not claim a new green full web suite.

Main CUA could not initialize because of the symlinked-root environment error. Real-provider Auth, the main authenticated browser UI, actual old-tab interactions and production were **not checked**. A protected project API returned anonymous 401 as expected; the report HTML entrypoint returned 200, which proves transport only. No production deployment, production database transfer or replacement occurred. The current linked-row and workspace-report limits above still apply.
