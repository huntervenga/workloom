# Gantt date move

**Status: accepted bounded move-only UX on `7b9a712`; feature source `441f5ae`.** This is a bounded additional input to the existing [P4b date preview/apply contract](18-p4b-contract.md). It does not rewrite that earlier checkpoint's historical exclusions. Source, compiled browser, database, runtime and old-tab results are recorded separately in [71](71-night-verification.md). The final DG build passed all **10 Gantt native cases in 16.1s**, within the complete final 97-case sequence; the separate four legacy meeting cases make 101 final distinct compiled cases overall. Later `2f71ad8` / BRg changes Graph disclosure wrapping; current `bd8ce21` / Tdb changes Graph locale/accessibility labels. These feature gates remain attributed to `7b9a712` / DG rather than silently rerun; the separate follow-up evidence is in [71](71-night-verification.md).

## User interaction

In Timeline, drag the **saved current body** of an eligible task bar horizontally. A primary left pointer starts one gesture per QueryClient; a 4px movement threshold separates a drag from a click. The displacement snaps to whole calendar days using the current pixels-per-day scale, with half-day ties rounded away from zero in both directions. A click, subthreshold motion, zero snapped delta or fully clamped no-op does not create a draft or request preview.

The saved bar/point, its anchor, current dependency connectors and baseline remain at their saved positions throughout the gesture. A separate dashed, pointer-transparent **proposed, not applied** ghost shows the proposed dates. It has no saved dependency anchor. A proposal beyond the visible window receives an outside-window ghost label; the gesture does not pan or enlarge the calendar window.

On a valid changed drop, the page owner atomically stages **one new retained date draft** and requests one server preview for that exact input. The existing **Edit task dates** dialog opens for review. Dropping is not a save. Review the server's before/after dates, dependency comparisons and protected/readiness results, then explicitly choose **Apply dates**. Only that step sends the keyed schedule write.

The keyboard/mobile alternative is the existing **Edit dates** button on an editable row: focus it and press Enter, enter dates or use day shifts, choose **Preview changes**, then explicitly **Apply dates**. A pointer gesture is optional; there are no keyboard bar-drag shortcuts. This input uses the same preview/apply and retained-command rules as a pointer proposal.

## Eligible source and move gate

A bar is eligible only when the current loaded task list has settled and every loaded task has a successful authorized schedule-context row, with no pending/refetching/error/denied schedule context. The source task and context must identify the same task in the current project. The project must be writable; the task must be unarchived, ordinary rather than a meeting, and its context must permit date editing. At least one valid current endpoint must exist. An undated row, meeting, missing context, viewer/read-only row, historical baseline, invalid/reversed range or invalid context revision cannot supply a movable body.

Eligibility is distinct from the synchronous page-owned move gate. A new gesture and its eventual drop are both refused when any of these holds:

- Any command registered for this QueryClient is pending or has an unknown outcome, including an unrelated task title save.
- Any retained **schedule** draft exists, even closed, untouched, on another row, or created in the same event tick before React renders. A retained move lease also closes this gate.
- Current schedule access is denied, or the actor/workspace/project controller scope has departed.

A refused move neither opens nor edits an older draft and sends no preview or apply. Existing **Edit dates** remains the manual entry/recovery route subject to its normal guards. Unrelated retained task drafts keep their existing owners; they are not by themselves the schedule-draft gate. The gate never discards another feature's draft or command to make a bar movable.

## Exact dates and immutable source

[dateGesture](../apps/web/src/features/schedule/dateGesture.ts) captures immutable task ID, title, original nullable start/due and **`expectedRevision` from schedule context `taskRevision`**. It does not substitute the list task's revision, recompute dates from effort, infer a missing endpoint, or accumulate rounding from prior pointer frames. Every frame derives the whole-day delta from the original pointer position and original source.

Date arithmetic is date-only across **0001-01-01 … 9999-12-31**, including leap years and DST boundaries. Both known endpoints move by the same clamped delta, preserving the inclusive range duration. A start-only or due-only point stays a point: the absent endpoint remains `null`. The shared delta is clamped to calendar bounds; endpoints are not independently clamped. The existing 28/84/366-day viewport limits, clipping and true endpoint labels remain [P4b](18-p4b-contract.md) behavior.

Changing the source task/title/revision/dates, actor/workspace, loaded/filter/view/baseline scope, window, zoom or measured track geometry cancels an active gesture. Escape, pointer cancellation, lost/failed capture, page/track scroll, resize, blur, document hiding and unmount also cancel. Cancellation clears the active ghost, releases its lease and stages no proposal. Only the click following an activated drag is suppressed; ordinary clicks remain available.

## Protection lease and retained recovery

[useGanttMove](../apps/web/src/features/schedule/useGanttMove.ts) acquires protection synchronously in the pointerdown stack, before pointer capture, focus changes or React effects, and cancels active mount-affecting reads in the current root/project/task/schedule/head scope. This prevents already in-flight answers from replacing the gesture owner even when transport ignores abort. The live-refresh protection contract is [70](70-workspace-live-refresh.md); it deliberately suspends this feature's head/catch-up requests while protected and does not promise current revocation notification during editing.

An accepted drop transfers that exact protection lease to [the page-owned schedule controller](../apps/web/src/features/schedule/useScheduleWorkspace.ts). Closing the dialog, changing view/filter, or unmounting the individual bar does **not** release a retained move's lease. Explicit discard releases it once; confirmed apply success removes the draft and releases it; actor/workspace/project controller cleanup releases all adopted leases. A refused drop leaves disposal with the gesture. No second gesture may replace the retained proposal.

Preview is an authorized, keyless **read** through existing `schedule-preview`, although its HTTP method is POST. It is neither an apply nor an idempotent command receipt. A late preview is accepted only if its request stamp and normalized input still match the retained draft. Editing the draft invalidates the old preview. Apply requires a matching current preview fingerprint/hash, no held command or denial, and no protected target/readiness blocker.

A known stale/conflict result preserves typed dates. Explicit refresh/rebase uses fresh context `taskRevision` and requires a **new preview**. An unknown apply outcome retains its original method/path/body/idempotency key and protection lease; no drag, refresh, polling cycle, filter/view change or newer source read retries or rewrites it. Only explicit Retry replays that exact request. A held unknown command cannot be discarded or changed as if it had failed. On success the controller invalidates/refetches current task/schedule/dependency reads rather than merging an old replay receipt over a newer source. These rules extend the existing retained-owner conventions in [68](68-asana-table-editing.md).

## Server and scope limits

The gesture adds no endpoint, mutation hash, schema migration or new permission. Existing schedule preview/apply still enforce current authorization, source freshness, workspace barrier, planning guards, dependency comparisons and atomic date writes from [18](18-p4b-contract.md). The pointer's source is a proposal base, not permission to save stale dates. Meetings retain their calendar workflow. Baselines, effort, plans, actuals, package originals, dependency topology and personal Graph coordinates are not derived from a date gesture.

This is **move only**: no endpoint resize, automatic scheduling/cascade, auto-pan, critical path, calendar connector, multi-row pointer move or full Asana parity is included. Physical touch and physical IME remain unverified; a browser's emulated touch-cancel case is not a physical-device result. Real Auth/private ACL, production and authenticated flows remain separate gates.

## Verification boundary

Frozen source includes [GanttMoveBar](../apps/web/src/features/schedule/GanttMoveBar.tsx), [GanttView](../apps/web/src/features/schedule/GanttView.tsx), [gesture tests](../apps/web/src/features/schedule/useGanttMove.test.tsx), [bar integration tests](../apps/web/src/features/schedule/GanttMoveBar.test.tsx) and [atomic handoff/unknown tests](../apps/web/src/features/schedule/useScheduleWorkspace.move.test.tsx). Tests cover immutable context revision, null endpoints/calendar bounds, separate saved/ghost geometry, same-tick retained drafts, global unknown commands, lease transfer/cleanup, stale previews and exact retry. Their existence is source evidence.

The [10-case native source](../tests/e2e/gantt-date-move.spec.ts) separately specifies real mouse range and point moves, Escape/no-op, browser-emulated touch cancellation, viewer/meeting/archive exclusion, retained manual draft, lost apply/title acknowledgements and mobile keyboard fallback. Root ran all ten compiled cases after the inspection-only correction described below: **10/10 passed in 21.1s**, `/private/tmp/workloom-final-native-gantt-date-move-fixed.log`. The later final DG run independently passed **10/10 in 16.1s** (`/private/tmp/workloom-daily-recovery-native-gantt-date-move.log`); exact checkpoint scopes and all earlier REDs are in [71](71-night-verification.md).

The first root compiled run was **8 passed / 2 failed of 10 in 53.7s**. Both failed cases reached preview and then timed out inspecting the saved background with an accessibility locator while a modal hid it. A test-only hidden-background inspection correction was followed by a separate full **10/10** rerun on the same CP8 product build. The failed run is preserved in [71](71-night-verification.md); the corrected pass does not retroactively change it.
