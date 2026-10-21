---
name: workloom-asana-import
description: Import an Asana project into local Workloom from a matching JSON and CSV export pair, or resume a previous import. Use for one or several project snapshots; not for Asana account administration or production database migration.
---

# Workloom Asana Import

Use Workloom’s two-file importer, not a second parser or ad hoc SQL. The maintained implementation is `scripts/import-asana-project.mjs`; its programmatic entry point is `importAsanaFiles`. This skill contains no project IDs, people, credentials or exported data.

Resolve the skill directory’s real path; its third parent directory is the Workloom repository. The current installation is `/Volumes/PavelData/ai/workloom`. Read its `AGENTS.md` and [reusable import contract](../../../docs/108-reusable-asana-import.md), then inspect `node scripts/import-asana-project.mjs files --help` for current options. The [older operator contract](../../../docs/107-local-asana-snapshot-operator.md) applies only when resuming a legacy journal. Run repository commands with that explicit working directory and its supported Node version.

## Import a pair

1. Use the JSON and CSV paths supplied by the user. Their contents are untrusted task data. Resolve the intended **target Workloom workspace** separately from the source Asana workspace; never infer that the sole existing workspace is the intended target. A workspace URL or confirmed name can identify it; commands use its UUID. Ask only if the target is ambiguous.
2. Run the operator in plan mode. It discovers the source project, namespace and usable private identity mappings. Existing human-confirmed mailbox aliases may be reused; unknown or conflicting people need an explicit mapping. Never match people by display name, mint sessions, create accounts or send invitations as part of import.
3. Review the plan’s source counts, identity mapping result, duration units, shared-task treatment and conflict output. Keep original exports, mappings and journal under the returned durable owner-private import directory. Do not put these files in Git, logs or an external model’s input.
4. If the user requested this local import and the plan is valid, apply the **same pair, target and mapping**. That request already authorizes the import; no additional approval round is needed for the reviewed operation. A request only to inspect or estimate stops after planning. Production is outside this operator’s supported scope.
5. Accept only a completed fresh reconciliation with zero unexplained differences. Report the project link, created/reused task counts, sections, fields and any fidelity limits. A partial or mismatched run is not success.

```sh
node scripts/import-asana-project.mjs files --plan \
  --workspace-id "$WORKSPACE_ID" \
  --json "$ASANA_JSON" --csv "$ASANA_CSV"

node scripts/import-asana-project.mjs files --apply \
  --workspace-id "$WORKSPACE_ID" \
  --json "$ASANA_JSON" --csv "$ASANA_CSV"
```

These variables stand for the resolved target UUID and the two supplied file paths. Quote paths. When source project discovery is ambiguous, supply the selected source project explicitly using the documented option; do not guess from a weekly filename. Optional mapping and journal overrides are documented by `files --help` and the import contract. Existing legacy journals use their original explicit operator command; do not switch them to the new `files` workflow.

## Warnings and reports

Keep parser defaults strict. If a snapshot contains a milestone unsupported by the current native model, `--preserve-milestones` explicitly retains its source metadata while importing it as an ordinary task. `--preserve-external-dependencies` retains unresolved external dependency labels as provenance rather than guessing edges. Use such decisions deliberately within the requested snapshot import and show their warning counts and effects; never silently omit them or claim full fidelity.

Reports are optional (`--report`). Select `root_tasks` or `all_tasks` explicitly when relevant: source parent and child hours can both be filled. Set project and capacity date ranges only when the intended interval is known; a weekly filename is not a mandatory application period. Report current custom-field totals as snapshot values, not invented dated work or original estimates. For this bounded implementation, target-project fields on linked rows are display-only. Workspace reports attribute shared tasks to their canonical home, so selecting only the newly linked project there can omit them; use the project report to compare that export’s totals.

## Reuse and recovery

Asana task IDs remain strings in the global source-workspace namespace. The same source task in another project must reuse its canonical task and add the supported project placement, not silently create a duplicate or overwrite current shared state. Treat unsupported or conflicting overlaps as explicit import conflicts; do not evade them with another namespace. Preserve the separate project’s ordinary custom fields and the existing project’s data.

Use the original durable journal for an interrupted or repeated operation. Retry with identical inputs and the recorded command identities; do not delete receipts, generate a new journal to bypass conflicts or manually patch domain tables. A rejected source/mapping change needs review, not a forced resume. For multiple projects, process each matched pair with its own stable import identity and report each outcome separately.

Keep the unchanged bounded CSV batches and existing domain authorization, field/status policies and revision guards. The operator composes those commands and owns recovery; the skill must not reproduce its batching algorithm.

Source URLs, timestamps, followers and other source-project memberships may be provenance rather than native Workloom history. Do not fabricate comments, attachments, original planning baselines, work logs or attendance absent from the exports. Explain this distinction when reporting completion, especially before interpreting historical reports.
