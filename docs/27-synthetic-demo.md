# Clean synthetic daily workspace

Candidate setup: `scripts/bootstrap-daily-demo.mjs`. It has **not been executed**. The existing workspace, users and 183 active historical projects remain intact. Execution waits for the coordinator's source/API window and explicit script review.

```sh
node scripts/bootstrap-daily-demo.mjs --dry-run
```

Dry-run is the default and performs no network or database access. It prints the exact planned workspace and six membership rows. Proposed workspace: **Workloom Studio**, stable ID `31800692-b5ab-4c59-87c9-118d9ea8eac9`, timezone **Asia/Nicosia**, Monday week start. The app's synthetic local identity badge applies. All six existing actor names remain Synthetic Owner/Admin/Member A/Member B/Member C/Viewer; no real people are represented.

The new workspace/membership rows use the repository's existing `createDatabase`/schema transaction seam, additive inserts and collision/drift checks, equivalent to the synthetic seed's insert-only policy. This is necessary because workspace creation/invitations are outside the local API. The script never updates existing users, workspaces or memberships. Every project, task, field, dependency, planning, fact, meeting and report mutation uses its validated API/domain command.

The script plans two concise projects, **Product launch** and **Team operations**, with 18 tasks including one shared meeting. Main-project work types are Research, Delivery, Quality and Teamwork; Risk and Review link provide two further typed columns. Tasks have purposeful names, dates, estimates, owners/participants and three finish-to-start dependencies. Example review URLs use `example.test` and imply no external account or service.

Dates derive from an explicitly captured Asia/Nicosia current date and are persisted in a private manifest. Current-week plans are created first, meeting plans use preview/apply, then the real current plan is previewed and frozen. `protectEstimate=false` keeps current estimates editable; the immutable baseline preserves the values that actually existed at freeze time. No original estimate, frozenAt timestamp or source history is fabricated. Facts follow the genuine freeze, including a confirmed zero, partial meeting attendance and distinct tasks with no fact. Pinned weekly and work-type reports use server summaries.

Approved execution will use:

```sh
node scripts/bootstrap-daily-demo.mjs --execute
```

An exclusive setup lock prevents overlapping runs. `.local/demo/daily-v1.json` (0600 in a 0700 directory) stores stable command keys and the exact original parsed body **before each request**. An interrupted unknown response retries that original body/key. Completed commands reuse validated stored results without recreating tasks or facts. A lost manifest, target collision or fixture drift causes refusal; do not invent fresh keys to continue.

Before the first addition, the script captures every original public table's primary-key set, row count and canonical JSON-row digest in a read-only REPEATABLE READ transaction in the private manifest. At completion, in a separate read-only REPEATABLE READ transaction, it reads exactly those original keys and compares all original rows, allowing only additive new rows. Thus preservation covers the original tenant's tasks, history, plans, reports, receipts and related records, not merely project names. A concurrent unrelated writer would make that check fail and require review; no rollback or data replacement is attempted. Keep the initial demo execution inside the coordinated quiet window.

The new-project English status template must be running in the API before execution. The script refuses Russian status defaults; it never renames existing status data directly. It also requires ready database/schema checks, the existing default Synthetic Owner, local identity mode and the exact loopback PostgreSQL endpoint. It never prints credentials.

Actual setup, preservation, links and browser acceptance will be recorded separately in [25](25-ux-verification.md). A dry-run is not data-persistence proof.
