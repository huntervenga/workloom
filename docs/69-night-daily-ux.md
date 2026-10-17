# Night daily UX: accepted bounded local checkpoint

**Status: accepted as bounded local UX on compiled code `5708be0`, 17 October 2026.** This is the first night UI checkpoint after `5ca0487`. Its root gates, failed attempts and runtime boundaries are recorded in [25](25-ux-verification.md); the phase record is [24](24-current-ux-run.md). Later workspace live-refresh/change-head source and app wiring are outside this code checkpoint. [70](70-workspace-live-refresh.md) remains **PROPOSED**, with no implemented or accepted cross-client synchronization claim here.

This is the local synthetic Workloom slice. The changes preserve explicit writes, current authorization, immutable first-freeze observations, unknown-outcome recovery and the distinction between missing, unknown and confirmed zero. Real Auth/private ACL, production deployment, physical touch/IME, Safari, old-tab upgrade and runtime preservation need their own evidence. A source test does not establish a native-browser or PostgreSQL result.

## Everyday navigation and task editing

- The sidebar lists the current workspace's active projects using the existing project read and cache, in server order. A failed read hides cached project names and offers an explicit retry. The current project's own task-page link preserves its full URL and does not clear filters, week, person or the open task. This is navigation, not a saved-view feature.
- The project **Week** link precedes the occasional **CSV import** view. Valid status/participant/tag/archived filters are URL state, so reload and Back/Forward restore them. Search text remains in memory. The URL parser rejects malformed/duplicate values rather than interpreting them as new capabilities; independent context updates preserve unrelated URL keys.
- Clicking an editable task title, Enter continuation and the serialized explicit-create queue retain the [68](68-asana-table-editing.md) behavior. **Open details** is a separate action. No background save result replaces a newer input buffer or silently discards an unknown create.
- **Move to section** uses the guarded inline choice editor for an ordinary editable root task. Active same-project sections and **No section** are the destinations. It updates `sectionId` only; no reparenting, cross-project transfer, meeting move or section drag is added. The destination expands after confirmation. Current revision, permission and exact unknown-retry rules remain authoritative.
- A parent task drawer shows loaded direct subtasks with full titles, status, archive state and whether they share the parent's package or are additional work. It labels partial/filter-limited coverage and keeps the parent's draft when opening a child. It is not a new complete-tree read or a client total.

## Current and original package estimates

The current shared budget and **Original estimate** have separate labels in the existing task drawer and saved personal-plan dialog. Detail children share their root's work package; additional scope has a different package. A new empty plan draft does not request an original estimate.

The additive read is `GET /api/v1/workspaces/:workspaceId/planning-packages/:packageId/original-estimate`. It checks current workspace/package/project access and reads the immutable first related plan-freeze observation. It does not freeze overdue periods, materialize meetings, create a receipt or write audit/outbox. No new schema migration or original-estimate acceptance command is introduced by this read.

| Server state | Display meaning |
| --- | --- |
| `not_captured_yet` | No related freeze has observed the package; there is no saved original yet |
| `captured` | The first related freeze captured known minutes, including **0**, with `first_known_plan_freeze` provenance |
| `original_unknown` | The first related freeze observed no estimate; later fills or freezes do not turn that into a known original |

Origin comes from the immutable observation/header/snapshot: plan baseline, week start, personal/project scope, manual/cutoff mode, freeze time and package revision. The GET never substitutes the current estimate or the time of reading. An inconsistent stored relationship fails closed. It does not add fields to old package DTOs, snapshots, previews, hashes or replayed command results. The exact contract is in [13](13-p2a-contract.md).

A confirmed freeze invalidates actor/workspace original-estimate queries so the UI rereads the server. Loading, temporary failure/retry and denied/unavailable states remain separate from the three domain states; unavailable data is not displayed as zero.

## A compact weekly page

Period and **Time entry for** use compact custom pickers. The project freeze status keeps the deadline, save action, overdue/preparation warnings, blocker reasons, access errors and command recovery visible. Detailed read/freeze timestamps and automatic-freeze configuration use disclosures. A disclosure never performs a write merely by opening.

**Show plans and hours for** defaults to **All people**. **(me)** or a named person filters the loaded saved plan/fact lists only. It does not change **Time entry for**, the acting user or report membership. Hidden rows are announced; **Show all people** makes a hidden saved-plan draft reachable again. New-entry drafts remain tied to their original period and person. No authoritative weekly totals are computed from the displayed list.

Personal plans keep work/person, planned and unallocated hours, removed/added/baseline labels and contextual Edit/View actions in compact rows. Unknown plans, a confirmed zero, removed entries, void facts and absent facts remain distinct. **Use shared estimate** copies the current package minutes into a personal draft only; saving that plan is a separate explicit command.

## Saved reports and explicit calculations

The report toolbar contains the saved-run picker, **Calculate current report** and **Set up new report**. Without an explicit run, the plan/fact view reads the newest saved run for the current project's baseline; the work-type view reads the newest saved breakdown for the selected period. An explicit URL run takes precedence. These fallbacks do not write a run ID into the URL or calculate a report on view.

**Calculate current report** explicitly requests the project baseline, all people and the complete comparison rather than a known-only subset. **Calculate current breakdown** explicitly requests everyone. Setup retains the chosen baseline, people and known-only settings for a separate explicit calculation. Dirty settings, errors and pending/unknown calculations keep setup reachable and preserve the original request. A late completion cannot replace a period, view or run selected in the meantime.

The saved result keeps its as-of cutoff, baseline scope, known-only warning and latest/selected identity. Longer version/pinning explanations live in **About this saved report**. The plan/fact summary and person chart use server totals from the immutable run; pagination does not alter them. Missing-actual coverage and its optional filter refer to that saved run and explicitly identify loaded-row limitations. A missing fact is not zero. The work-type person lens uses saved `byPerson` groups; source details and report totals remain report-wide, and uncategorized minutes stay in share denominators.

## Timeline and Graph

**Timeline** uses a bounded calendar axis with month segments, weekday/day markers, weekends and today. Its first complete authorized loaded/current snapshot chooses a fitting 28/84/366-day window once. An earlier user choice wins, and refetch, filters, more pages, baseline selection and date changes do not reset the viewport. **Fit loaded tasks** performs a new fit only when clicked. Empty/undated scopes keep the bounded fallback; a range wider than 366 days gets an explicit limited-window notice. No whole-project coverage is inferred from loaded rows.

Current finish-to-start connectors require server comparisons and both ordinary endpoints rendered at the matching current dates inside the window. Compatible/conflicting lines differ visually and have a textual legend. Meetings, missing dates, unloaded/outside endpoints and mismatched reads produce explained skips. Connectors follow measured current bars or one-date markers; they do not describe historical topology or create/update dependencies. Selected baseline overlays use the same window without changing the fit.

Dates still change only through explicit input → server preview → atomic apply. Navigation, fit, zoom, drawing and scrolling do not write. Pointer date drag/resize, automatic cascading and converting effort to days remain future work. The date-only and snapshot boundaries remain in [18](18-p4b-contract.md).

**Graph** starts with the diagram on screens at least 768px wide and with the list on narrower screens; both views remain selectable. The legend explains direction and distinguishes unresolved predecessors from those in the done status group. Selecting a task highlights direct predecessors/successors within this loaded diagram and dims unrelated content; the current authoritative blocker summary may cover more than the rendered graph. Personal position dragging/layout saving stays separate from dates and effort, with the existing rights, bounds and immutable command rules.

## Meeting preparation and attendance

Saved actual meeting details have a compact summary and an explicit editor. **Meeting followed the plan · fill details** fills only an unsaved actual-details draft; **Save actual details** remains required. Full and partial attendance use the saved actual start/duration, while planned absence remains a separate explicit zero outcome.

**Everyone attended · prepare review** prepares full attendance only for unconfirmed people on the current roster. Existing saved, partial, absent, void and unsent user-edited rows are preserved. Preparation does not post facts. The person reviews the selected rows and explicitly confirms the team batch; cancellation, permissions, limits, revisions, correction reasons and exact unknown retries remain enforced. Saved per-person attendance and counts are not a client estimate of total hours. Meeting facts continue through the guarded meeting path, not generic weekly manual entry.

## Root acceptance matrix — `5708be0`

| Gate | Result for this first night checkpoint |
| --- | --- |
| Code identity | Compiled code `5708be0`; 103 first-milestone source paths, excluding later live-refresh source/wiring |
| Build and static checks | Full build, global lint/boundaries/localization and root types passed before the final title style fix. After that fix, final web build including `tsc` and ESLint on 93 changed TS files passed. No claim over the later phase2 working tree |
| Frozen full web | **1,216 passed in 155 suites, 365.74s** |
| Backend unit | **1,321 passed in 79 suites, 23.63s** |
| Real PostgreSQL original-estimate oracle | **8 passed, 7.51s** |
| Pure original-estimate oracle | **4 passed, 99ms**; not PostgreSQL cases |
| Planning/cutoff/field-policy PostgreSQL regressions | **16 passed in 3 suites, 13.55s**; separate scope |
| Frozen new night compiled native | **25/25 passed, 1.6min** |
| Legacy Asana compiled native | **39/39 passed, 1.6min**, unchanged assertions after a real mobile title/action overlap fix |
| Legacy meeting/time-context compiled native | **4/4 passed, 33.2s** |
| Browser accounting | **68 distinct cases** across the three final runs above; the earlier focused connector pair is not added again |
| Actual demo | Four read-only views; zero writes, errors or overflow. Saved plan 94h / baseline fact 84h 45m / all fact 88h; 121h known original versus 123h current loaded budget |
| API-only preservation | Separate gate at 00:22:01.655 UTC: 60 public tables, 31,305 rows and unchanged digest; exact PG/Vite identities preserved, worker OFF. Historical pre-QA snapshot, not current inventory |
| Old-tab, Auth/private ACL, physical touch/IME, Safari, production | Not rerun or claimed |

Frozen run logs are `/private/tmp/workloom-night-checkpoint-web-frozen.log` and `/private/tmp/workloom-night-checkpoint-native-frozen.log`, with native artifacts under `test-results/night-ux-frozen`. The full ledger in [25](25-ux-verification.md) preserves every earlier failed/interim run, the separate real-PG and pure-oracle scopes, review provenance, exact API-only conservation proof and its limits. These results accept this bounded local checkpoint, not Asana parity, a full migration, production readiness or proposed cross-client synchronization.
