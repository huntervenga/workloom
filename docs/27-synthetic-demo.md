# Clean synthetic daily workspace

Reviewed setup `scripts/bootstrap-daily-demo.mjs` **executed successfully on 2026-10-16, 08:39:35.113–08:39:39.804 UTC**. All 82 API/domain commands were acknowledged. Before/after snapshots matched all 54 tables / 14,647 original rows exactly, including pre-existing browser fixtures. The original workspace, users and historical projects remain intact.

```sh
node scripts/bootstrap-daily-demo.mjs --dry-run
```

Dry-run is the default and performs no network or database access. It prints the exact planned workspace and six membership rows. Workspace: **Workloom Studio**, stable ID `31800692-b5ab-4c59-87c9-118d9ea8eac9`, timezone **Asia/Nicosia**, Monday week start. The app's synthetic local identity badge applies. All six existing actor names remain Synthetic Owner/Admin/Member A/Member B/Member C/Viewer; no real people are represented.

The new workspace/membership rows use the repository's existing `createDatabase`/schema transaction seam, additive inserts and collision/drift checks, equivalent to the synthetic seed's insert-only policy. This is necessary because workspace creation/invitations are outside the local API. The script never updates existing users, workspaces or memberships. Every project, task, field, dependency, planning, fact, meeting and report mutation uses its validated API/domain command.

The script created two concise projects, **Product launch** and **Team operations**, with 18 tasks including one shared meeting. Main-project work types are Research, Delivery, Quality and Teamwork; Risk and Review link provide two further typed columns. Tasks have purposeful names, dates, estimates, owners/participants and three finish-to-start dependencies. Example review URLs use `example.test` and imply no external account or service.

Dates derive from an explicitly captured Asia/Nicosia current date and are persisted in a private manifest. Current-week plans are created first, meeting plans use preview/apply, then the real current plan is previewed and frozen. `protectEstimate=false` keeps current estimates editable; the immutable baseline preserves the values that actually existed at freeze time. No original estimate, frozenAt timestamp or source history is fabricated. Facts follow the genuine freeze, including a confirmed zero, partial meeting attendance and distinct tasks with no fact. Pinned weekly and work-type reports use server summaries.

For deliberate exact replay, preserving the original private manifest:

```sh
node scripts/bootstrap-daily-demo.mjs --execute
```

An exclusive setup lock prevents overlapping runs. `.local/demo/daily-v1.json` (0600 in a 0700 directory) stores stable command keys and the exact original parsed body **before each request**. An interrupted unknown response retries that original body/key. Completed commands reuse validated stored results without recreating tasks or facts. A lost manifest, target collision or fixture drift causes refusal; do not invent fresh keys to continue.

Before the first addition, the script captures every original public table's primary-key set, row count and canonical JSON-row digest in a read-only REPEATABLE READ transaction in the private manifest. At completion, in a separate read-only REPEATABLE READ transaction, it reads exactly those original keys and compares all original rows, allowing only additive new rows. Thus preservation covers the original tenant's tasks, history, plans, reports, receipts and related records, not merely project names. A concurrent unrelated writer would make that check fail and require review; no rollback or data replacement is attempted. Keep the initial demo execution inside the coordinated quiet window.

The new-project English status template must be running in the API before execution. The script refuses Russian status defaults; it never renames existing status data directly. It also requires ready database/schema checks, the existing default Synthetic Owner, local identity mode and the exact loopback PostgreSQL endpoint. It never prints credentials.

Actual setup, preservation and browser acceptance are recorded separately in [25](25-ux-verification.md). A dry-run alone is not data-persistence proof.


## Open the clean example

- [Product launch](http://127.0.0.1:4310/w/31800692-b5ab-4c59-87c9-118d9ea8eac9/projects/9266f142-b72a-40b8-bb86-350d6df7c209)
- [Team operations](http://127.0.0.1:4310/w/31800692-b5ab-4c59-87c9-118d9ea8eac9/projects/9b71d2ff-cd2e-49f7-b9ba-03a79a75ef69)
- [Launch week](http://127.0.0.1:4310/w/31800692-b5ab-4c59-87c9-118d9ea8eac9/projects/9266f142-b72a-40b8-bb86-350d6df7c209/week?period=c0d29b3f-f190-4b18-ac4a-379446d88dc0)
- [Saved weekly report](http://127.0.0.1:4310/w/31800692-b5ab-4c59-87c9-118d9ea8eac9/projects/9266f142-b72a-40b8-bb86-350d6df7c209/week?period=c0d29b3f-f190-4b18-ac4a-379446d88dc0&view=report&run=bbbf7a98-0aaa-4023-90f5-41f72e5f4405)

The saved report records 39h 30m planned and 20h 55m actual, with 75% fact coverage; missing facts intentionally leave total variance unavailable. It is a synthetic teaching example, not fabricated performance evidence for real people.
