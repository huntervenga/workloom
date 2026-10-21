# Company addresses

## Choose a short workspace URL

As the workspace owner, open **Overview → Company address**. Enter a short name such as `balancy` and choose **Save address**. The preview shows the resulting URL: `http://127.0.0.1:4310/app/w/balancy`. The same routing applies on the production origin when deployed.

Names contain 3–63 lowercase ASCII letters, numbers and single internal hyphens. Names are case insensitive; reserved names and names already owned by another workspace cannot be selected. The server checks availability when saving. This setting belongs to the owner; admins and other members can see the address but cannot rename it.

Projects, reports, task links, schedules and navigation use the workspace’s current short address. Previous names remain reserved aliases, so existing links continue to open the same workspace and are replaced with its current URL. Existing UUID URLs also continue to work. Changing the short name does not change task, membership, report or workspace identities.

The address is not an invitation or an access grant. Only signed-in members can resolve and open a workspace. Unknown addresses are not queried as workspace IDs. Existing sign-in and personalized invitation requirements still apply.

## Save feedback

A rejected name remains editable. A revision conflict refreshes the current workspace address so the owner can review and save again. If the connection is interrupted after sending, **Retry same save** sends the identical operation, revision and idempotency key to confirm its result. Do not create a different save while the previous result is unknown.

A canonical URL replacement preserves the current page, filters, open-task query and fragment. It does not discard drafts or clear the workspace cache. Navigating to a different workspace or page retains normal protection for unsaved changes and pending writes.

## Verification status

Staged frontend typecheck, full frontend ESLint and localization audit passed. Focused web tests passed 62 tests in 7 files; a subsequent overlapping UI run passed 10 tests, adding cached-old-list recovery. Private compiled Chrome acceptance passed 2 tests without retries or skips: owner address creation/rename; UUID and previous-name deep links preserving task/view/fragment; canonical project anchors; UUID API identities; and an explicitly retried save whose first successful response was lost. The synthetic Company address screenshot was visually inspected.

Draft preservation through same-workspace canonical replacement is covered by the browser-DOM unit suite; a native unsaved-title scenario is not claimed. Real-provider login, the main authenticated browser workflow, actual unreloaded old tabs and production remain separate checks. The local activation and actual address assignment below are separate coordinating-task evidence.

## Verified local activation — 21 October 2026

The coordinating task activated the bounded company-address and local Asana-operator build at `http://127.0.0.1:4310/app`. The final activation verification completed at **2026-10-21T15:58:20.677Z**. Only additive migration **0028_workspace_slugs** was applied:106→107 tables and28→29 migration ledger entries. Every old table's prior columns/rows, old schema/catalog, ledger prefix, environment and PostgreSQL/Vite process identity were preserved. The new registry was empty and every existing workspace received null slug/revision 1 at that preservation checkpoint. Only the API restarted; worker remained OFF. Verification checked **536 non-HTML resources and both HTML entrypoints**, including retained old resources by bytes/MIME.

The initial activation attempt **failed after the migration and before artifact promotion**: its exact CHECK-definition assertion omitted the parentheses PostgreSQL emits around the two BETWEEN comparisons. Read-only catalog inspection identified the formatting difference. The helper was corrected to the exact emitted definition; a separately invoked, guarded **finish-only recovery** verified the applied migration, original data/schema/env/processes and unpromoted artifacts, then promoted the accepted build and started the API. It did not rerun migrations or restore data. This was a recovered activation, not an uninterrupted successful first attempt.

After activation, the actual workspace owner configured **`balancy`** through the ordinary owner-authorized domain command. The saved address is revision2; an exact retry confirmed the same result. The workspace remains the same UUID and its existing members remain unchanged. This assignment was a separate authorized domain write after the preservation checkpoint.

Bounded acceptance passed global static/type checks, backend unit **2365 tests/146 files**, focused PostgreSQL **5 tests/4 files**, the separate synthetic Asana-operator integration **1 test/1 file**, focused slug web **62 tests/7 files** plus an overlapping **10 tests/1 file** run, build and private compiled Chrome **2/2 tests** without skips/retries. The broader web run was **RED: 2735 passed/9 failed across 342 files**. All nine failures were reproduced on baseline `a1070d1`; mechanical test-only corrections passed **86 tests in 8 files** in focused reruns. The full web suite was **not rerun after those corrections**, so no full-suite-green claim is made. Initial failed check/type attempts and the activation formatting failure remain part of the evidence history.

The coordinating task's private evidence is under `/private/tmp/workloom-slug-asana-38a503a2-80c7-4734-931f-9b951db302d9/`. Main authenticated browser behavior, real-provider sign-in/registration, actual unreloaded old-tab interaction and production deployment were not verified by this activation. Retaining and checking old resource bytes does not establish an old-tab workflow pass. The authorized import and its limits are recorded separately in [107](107-local-asana-snapshot-operator.md).
