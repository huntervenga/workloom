# Local Asana snapshot import operator

This adapter recreates one explicitly selected Asana project from matching JSON and CSV exports through existing Workloom domain commands. It is a local owner-operated tool, not a new HTTP route or an authentication bypass. No production deployment is part of this tool.

## Scope and fidelity

Run `scripts/import-asana-project.mjs` with Node24 against the managed local PostgreSQL database, `APP_ENV=local` and `AUTH_MODE=shared`. The tool accepts only loopback port55432, database `workloom_dev`. Its synthetic test entrypoint separately accepts only named test databases on55433. Database credentials come from the existing private environment and are never printed.

The operator validates the complete pair of source exports, every membership mapping, all scalar values, hierarchy, dates, dependencies and bounded artifacts before its first domain write. JSON task GIDs identify hierarchy and duplicates; titles are never identity. CSV dependency labels are accepted only when uniquely resolvable to a JSON task GID. Source note text is untrusted data and is preserved without executing or interpreting instructions.

Native imported data includes project name, section order, root/child manual order, titles, exact descriptions, assignees, completion status, tags, calendar dates, ordinary custom fields and supported dependency edges. Asana number fields can explicitly become ordinary duration fields using an exact hours-to-whole-minutes conversion; missing values remain absent and literal zero remains a typed zero. Select options and their colors are created through ordinary field commands. Source color names map to explicit display hex colors; original color labels remain in provenance. Tags without source colors receive a deterministic display palette.

Source timestamps, source URLs, followers, original field definitions/raw values and other project memberships are retained in each staged row's `Asana source provenance` JSON and in owner-private original exports. They do **not** become invented Workloom history, historical completion timestamps, collaborators/participants or duplicate projects. Workloom creation/update times honestly describe the import. Comments, change history and attachments cannot be reconstructed when they are absent from these exports; summaries report them as `not_exported`, not as a claim that the source had none.

The global source namespace is `asana:<source workspace GID>`. This avoids silently duplicating a source task that appeared in multiple Asana projects. The existing bounded importer currently rejects references owned by a different target project; later importing another project that shares a task needs an explicit placement-aware follow-up. This operator imports only the selected current project.

## Private configuration

Create an owner-only JSON file (`chmod600`) outside committed source:

```json
{
  "version": 1,
  "workspaceId": "<Workloom workspace UUID>",
  "ownerUserId": "<current real owner's user UUID>",
  "shareableScopeConfirmed": true,
  "sourceNamespace": "asana:<source workspace GID>",
  "assignees": {
    "person@example.test": "<active Workloom membership UUID>"
  },
  "approvedEmailAliases": {
    "<source owner mailbox>": "workspace-owner",
    "<source mailbox that changed>": "<persisted invited mailbox>"
  },
  "durationFields": {
    "<source estimate field GID>": {
      "sourceUnit": "hours",
      "sourceMeaning": "current_estimate"
    },
    "<source actual field GID>": {
      "sourceUnit": "hours",
      "sourceMeaning": "current_actual"
    }
  }
}
```

Email aliases must be human-confirmed in this private mapping. Every pending assignee must match its persisted mailbox exactly, or consume a source-to-target mailbox alias. The special `workspace-owner` alias means only the exact pinned owner user/current membership; no owner mailbox is inferred from tokens or sessions. Duplicate target memberships and unused aliases/mappings are rejected. These identity checks run before every command, including resume. Pending teammates are valid planning assignees by their active membership IDs; the tool neither creates Auth accounts nor sends invitations. It derives the single active real workspace owner with an existing shared-Auth identity, checks the explicit owner ID and rechecks active mapped memberships before every command and final readback. No browser session, provider token or forged HTTP principal is used. The local human request authorizes an `import` command context; ordinary access, current cutoff/lock, field and status policies still apply.

## Plan, apply and resume

Use a durable ignored directory under `.local/imports/`, never a transient directory for the actual import:

```sh
node scripts/import-asana-project.mjs --plan \
  --workspace-id '<workspace UUID>' \
  --source-project-id '<source project GID>' \
  --json '/absolute/path/tasks.json' \
  --csv '/absolute/path/project.csv' \
  --mapping '/absolute/private/path/member-mapping.json' \
  --journal-dir '.local/imports/asana-current-board'
```

`--plan` performs read-only target checks and stores private copies plus a detailed plan, without domain writes. Both modes persist the exact current prepared plan; apply cannot leave an older preparer’s plan file behind. Review its aggregate counts and explicit mapping first. Repeat the exact command with `--apply` to execute. All arguments are required; unknown arguments and mixed modes are rejected. No source project, workspace, person or email is hardcoded in the script.

The unchanged public CSV importer still permits at most50 data rows per artifact. A105-task snapshot becomes three ordered artifacts of50/50/5. Each individual CSV application is atomic; the whole operator is not. Project/resources, batches, ordinary select values, dependency edges and owner column preferences have separate durable checkpoints. A failure leaves a clearly partial project for resumption, never a success claim or silent rollback.

The owner-private journal stores each exact command body, deterministic key and input digest **before** invocation, and the result/digest after success. If the process stops after a server commit but before a response is saved, retrying the same command reuses its key/body and the existing domain receipt. A process lock prevents concurrent journal owners; a dead same-host PID lock can be reclaimed on restart. Completed steps are checked for stored input/result drift. The owner and full source/mapping digest stay bound to the journal. Resume using the original files, mapping and journal directory; do not generate another target or retry with different revisions. Existing source references associated with a different journal/project stop a new run before project creation.

Final acceptance uses fresh domain reads and fresh staged artifacts, not cached command results. It checks every source ID, title/description, parent, section, relative sibling order, assignee, status, dates, tags, typed values, absent values, explicit zeros, options/colors, dependency edges, aggregate minutes and preserved provenance. Extra/missing tasks or any mismatch leave `reconciliation_failed`; inspect owner-private `reconciliation.json`. Only zero mismatches produce `complete` and a verified project ID.

Owner personal table preferences show the imported source columns and hide duplicate built-in legacy time/priority columns. They are not workspace-wide preferences for every member. The imported hour fields remain ordinary editable columns. No original planning baseline, work log, required week, participant allocation or generic report is manufactured by this operator.

## Verification

Focused source/journal tests:

```sh
node --test scripts/import-asana-project.test.mjs
```

Actual-command integration (use the private test URL environment, never the main database):

```sh
node --import tsx --test scripts/import-asana-project.integration.test.mjs
```

The integration creates and drops only its own child database using the existing throwaway helper. It exercises a synthetic105-task hierarchy with a parent spanning the50-row boundary, full typed values and provenance readback, a simulated lost response after the first committed batch, exact resume, completed replay without new receipts/entities, rejection of a second journal rejection of swapped active pending identities or a missing owner alias before any project write, and rejection after owner revocation. No real exported data is committed or sent to an external model.

## Verified actual local import — 21 October 2026

The coordinating task imported the user-supplied current Asana project into the existing **Balancy** workspace after the separate [company-address activation](106-company-addresses.md). Fresh final reconciliation completed at **2026-10-21T15:59:25.113Z** with **zero differences**. The resulting project is:

[Open the imported local project](http://127.0.0.1:4310/app/w/balancy/projects/09f36112-6090-46f9-aa9b-96125d12fd75).

The fresh readback verified 105 source task IDs: 80 roots and 25 children, 5 sections, 13 tags, 3 ordinary custom fields, 24 completed tasks, 98 assigned tasks, 1 dependency, 19 nonempty descriptions, 35 due dates, 4 start dates and 44 tagged tasks. Current source hours became ordinary user fields: **Estimation 12,780 minutes (213 hours)** and **Fact 4,680 minutes (78 hours)** across all imported rows; root-only sums are 160 hours and 69 hours. There are 21 missing estimate values and 65 missing fact values, plus one explicit zero in each field. Missing values remain missing; neither missing facts nor imported current estimates become historical worklogs or baselines.

The previously user-created four pending teammates and owner remained intact. The two human-confirmed source-mailbox aliases map the exported identities to the intended existing memberships. No Auth accounts were fabricated, and this import did not send invitations or create a second team.

Original permalinks, timestamps, followers and four additional source-project memberships are preserved as provenance only. The provided exports do not contain reconstructable comments, change history or attachments; those remain **not exported**, rather than being represented as a complete historical transfer. The import verifies a current project snapshot, not a full Asana account/archive migration. Production data transfer and a real authenticated-browser comparison against Asana are separate follow-up checks.

A final exact retry using the durable private `source.json`, `source.csv` and `mapping.json` archive returned the same project ID and created **no additional entities or command receipts**. Final counts for the imported scope are 1 project, 105 tasks, 105 external references, 3 import artifacts, 140 field values and 53 receipts, with 5 members including 4 pending teammates. Fresh `differences` remained empty. The owner-private verification record is `.local/imports/asana-current-board/final-verification.json`; the source files and mailbox mapping remain private and are not included in this documentation. The managed runtime doctor passed for all three owned services, with worker OFF.
