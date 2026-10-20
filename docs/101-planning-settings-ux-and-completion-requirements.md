# Planning settings UX and optional completion requirements

**Accepted and activated locally.** Product `9860ac5` (`9860ac54425ab4ff2a81a61f4fb0119759982356`) is active at `http://127.0.0.1:4310/app`. This documentation-only follow-up is later than the verified product snapshot. The preceding accepted behavior and original proofs remain in [100](100-configurable-planning-checks.md) and [99](99-table-summaries-section-widgets-and-field-controls.md).

## Already configured in the demo

Open [Team delivery · five-person demo](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d). Reload an existing tab to load the updated application. Through the ordinary authenticated owner interface, these rules were saved with project checks enabled, at settings revision **2**:

| Rule | Ordinary field and scope | Behavior |
| --- | --- | --- |
| **Estimate missing** | **Hours Estimation**; Todo, In progress and Done; all task levels and assignees | Red missing-value warning; completion requirement off |
| **Fact missing on completed tasks** | **Fact**; Done only; all task levels and assignees | Red missing-value warning, critical emphasis; **Require this field before completing tasks** on |

Both use the configured color `#dc2626`. The observed assessment includes **32 home tasks**, with **14** missing estimates and **13** completed tasks missing Fact. Eight tasks appear in both groups, so there are **19 distinct affected tasks**, not 27. No task values were filled in to hide these issues. A blank Fact cell was visibly red (`rgba(220, 38, 38, 0.094)`) and exposed **Needs attention: Missing Fact**. Critical is the saved emphasis setting; changing it is not claimed to have changed the background opacity.

To inspect or change this setup, choose **Checks → Edit** beside the desired rule. Adjust the field, status scope, emphasis, color or completion toggle, then **Apply rule → Save checks**. Do not create a duplicate rule merely to change its appearance. Field names are ordinary user labels; the rules bind to field IDs.

Maya’s section now has an ordinary **Fact · Sum** summary, saved directly through the interface without **Add another summary**, displaying **4h 45m**. Aggregate settings revision is **10**. Hunter’s three existing summaries were preserved exactly.

## Summary: configure and save once

Open the settings control beside a section or assignee heading. Choose a field and calculation, or choose **Person’s available working time**, a person and a period. **Save summary** includes the current editor automatically. Editing an existing summary also needs only **Save summary**; **Update summary** is optional.

**Add another summary** only prepares several summaries in one visit. It puts the current one in the list and opens a blank editor. Final Save includes the last configured editor too, without duplication. Up to four summaries are supported. **Project dates** uses the optional range set through **Project dates** in the project header; an unset range remains unavailable rather than silently becoming a week.

An incomplete editor shows a visible, focused explanation instead of dropping its values. **Cancel new summary** clears that editor while retaining other prepared summaries and removals. Opening settings or an existing summary without changing it is not an unsaved edit; Save unchanged settings simply closes without a write. A failed save retains the prepared summary and stable identity. Validation focuses its newly mounted message synchronously, so a delayed callback cannot steal focus from the next picker.

## Closing Planning Checks

X, Escape and **Close** immediately close pristine settings, including an inspected, unchanged rule. Real unsaved changes open a separate foreground confirmation: red **Discard changes** drops the draft and closes; **Keep editing** preserves it. The action footer stays visible while the rule list scrolls.

A pending or unconfirmed save has a visible explanation. **Retry same save** preserves the original command. Configuration still uses **Apply rule → Save checks**; ordinary task values continue to autosave.

## Optional completion requirements and planning colors

A missing-value rule can enable **Require this field before completing tasks**. Both project checks and that rule must be enabled. A matching task cannot enter a Done status until the selected ordinary field is filled, including a new task created as Done. Its status scope must include Done; leave it unrestricted or explicitly include completed tasks. New projects and ordinary presence rules do not silently opt into this requirement.

Missing means absent, cleared, blank text or an empty selection. Numeric zero and Boolean No are filled values. Existing completed tasks remain editable; reopening and completing again is a new completion attempt. The requirement does not block unrelated editing. The owner can edit or disable it through the same settings; there is no hidden field-name or owner bypass.

After a confirmed missing-field refusal, the task keeps its previous status and the explanation stays visible. Fill **Fact** in its table cell or task pane, let that value save, then complete the task again. No Save/Discard detour is needed to release the refused status choice, and unrelated typed text is retained. Only the trusted completion-policy HTTP 422 takes this recovery path; network uncertainty, generic rejections and revision conflicts retain their existing explicit recovery.

For workload colors, add **Planning load**, select a numeric/duration field, and choose the actual assignee or section plus capacity or a fixed target. Periods, task cohorts, thresholds and endpoint colors remain configurable as described in [100](100-configurable-planning-checks.md). Choose the rule grouping **Assignee** for individual load counts; the table’s visual Group by alone does not change a rule. Load colors remain advisory. The two demo presence rules do not automatically create capacity/load rules.

Current issues appear in the table and project [Reports](http://127.0.0.1:4310/app/w/2ea2e40e-b442-48b7-9b9d-45c26e9eb77b/projects/1268a6cd-c760-4c72-b4af-6caf988b303d/reports). Checkpoints remain explicit captures, without automatic periodic history.

## Table controls

Column names stay beneath the application header during page scrolling, with their real menus and add-column control. Horizontal scrolling still matches the underlying columns and pinned task-name column. The header stops at the table’s end. In the visible main Chrome tab, scrolling 600px left the table header at 56px, equal to the application header’s bottom, with the stuck state active.

When a table refresh makes the existing bulk-edit guard busy, custom and built-in editors/triggers now show their unavailable state, including already-open choices. This prevents a control looking usable when its submission cannot proceed. Permissions, frozen selection targets, revision checks and exact retries are unchanged.

## Verification and local activation

Final Candidate **G passed all 18 gates**, with no failed, skipped or flaky cases. These are scoped suites, not full-repository counts:

| Scope | Final result |
| --- | --- |
| Fresh build and global checks | PASS; 1,561 source files / 1,131 compiled artifacts |
| Unit | 441 tests / 30 files |
| PostgreSQL | 109 tests / 14 files; 166.24s |
| Web | 842 tests / 106 files; 210.06s under the unchanged 360s limit |
| Private compiled Chrome | 34 cases / 14 suites |

G ran its stages serially and added the relevant ProjectBulkInlineEditing coverage. Source SHA-256: `ce6d3dd2a0267afb4dcc5a7dcf05905f7af1f318420445e68a868509c1a11ae1`; build manifest: `6b2f7a60b88a6884f77a49387e3d570ecd066e40238c14f66f5ddd970cc6e88d`.

Proof catalogue: `/private/tmp/workloom-manager-reports-20261020/ux/build-429b8e0b-d592-4825-a7d1-7cf763f58bc3/final-ux-G-gates.json`, SHA-256 `12d164eb86b958e32ec728ced9f9aaf26e1747bfc497e51e6d4970d397c7e6cd`.

Controlled activation finished **20 October 2026 at 14:09:58 Asia/Nicosia** (`2026-10-20T11:09:58.688Z`): `.local/backups/ux-polish-d2a2c791-2e58-4a02-aaa6-09dc422bf46f/result.json`, `pass:true`. No migration, database write or restore occurred during activation. All 97 table row digests/counts, schema, 25 ledger entries and environment were conserved. Only the API restarted (new PID 20451); PostgreSQL and Vite remained unchanged, worker OFF. All 386 old non-HTML resources retained their bytes/MIME; 413 merged resources and two HTML entrypoints were verified.

The later ordinary owner UI actions intentionally changed check and aggregate settings. A separate read-only database proof confirmed that **tasks, custom-field definitions and custom-field values** still matched activation’s post-update row-count/digest baseline exactly: `/private/tmp/workloom-task-data-preserved-after-ui-20261020.json`, SHA-256 `245886b8449e9faa49ac5f05b69406c46a85d0844afea0ec9b9340360779afad`. This narrower post-UI proof is distinct from all-table conservation during activation.

Private cleanup passed: `/private/tmp/workloom-manager-reports-20261020/ux-cleanup-G-8b19f6b3-a0c2-4267-a96e-2a4d3bfffff2.json`, SHA-256 `b166a79acc966debe02a5147d5704e8005d14d0a001178ab4fbdbc066c883cfa`.

## Browser coverage and limits

The **existing authenticated Hunter Venga owner session** was used through ordinary main UI to save both rule and summary settings. Pristine X/Close, unchanged focused-rule closure, the enabled saved completion requirement, red missing Fact, exact summary preservation and visible pinned headers were checked. Main UI proof: `/private/tmp/workloom-main-ux-verified-20261020.json`, SHA-256 `a856604106916a50d532ccecfe1c65cb32933ce5d9877bf3eafd323ba1697b5f`.

That tab initially loaded the older build and was reloaded after activation while keeping its existing session. **Fresh Auth/provider login and writes from an unreloaded old tab were not exercised.** The main demo’s completion action was not attempted, to avoid changing tasks; its refusal → fill field → complete cycle was proved separately in private native/PostgreSQL tests. No production deployment is claimed.

Root reviewed G confirmation colors in both themes. An earlier Summary image captured during refresh and a drawer image captured during entry animation are not steady-data or final-geometry proof; native assertions and the later main checks provide separate evidence. An initial hidden-tab animation-frame check was not a valid visible-header result; the stated main measurements came from the normal visible Chrome tab.

The bounded home-task scope, private-task-ACL limitations and explicit checkpoint history from [100](100-configurable-planning-checks.md) remain. This slice adds neither automatic history nor new workspace-wide formulas.

## Preserved failures and repairs

| Earlier candidate | Actual result and correction |
| --- | --- |
| A | Build RED on seven test type errors involving unsupported role-query options; corrected test calls. |
| B | Global check RED on a type-import lint issue; corrected import. |
| C | Native Escape exposed a real dialog event-readiness race; D registered the portal child’s layer in its layout effect. |
| D | Sticky/completion readiness locators were anchored to named sections and the active Status combobox, preserving assertions. Root visual review rejected a conflicting Discard color class; explicit CSS variables and a computed-color assertion fixed it. |
| E | Web 815 PASS / 1 FAIL despite all 34 native cases passing. Deferred validation focus stole focus from the next Person picker. A controlled-frame regression reproduced it; synchronous layout focus then passed 20 focused cases. E was not activated. |
| F | Web 817/105 passed, but native light-theme bulk Boolean exposed a visibly enabled control while `tasks.isFetching` held the guard. Only the earlier duration request was sent. Reactive visible disabling and deferred-refetch/already-open-picker coverage passed 72 cases in five files before fresh G acceptance. |
| F PostgreSQL | A >100 recurrence case reached 120s, followed by a lock timeout; the outer run stopped at 240s, exit 143. E/F server artifacts were identical; E’s same case took 104.56s under 120s. Inspection found no persistent locks. A transient HTTP/unit-of-work stall after the first timeout remains an inference. Deadlines were not increased; G reran serially and passed. |

The Summary regression baseline also covered dropped active-editor values, disabled direct edit Save and false opening dirtiness. A bounded source-only subscription Claude Opus task contributed the shared Save path and Cancel new summary design; actual model `claude-opus-5-5`, without secrets or database contents. Known pre-existing React warnings were retained in the evidence rather than broadly changed in this slice.
