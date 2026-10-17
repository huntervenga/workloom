# Asana-like table editing

**Status: originally accepted as bounded local UX on compiled `5ca0487`; the first night additions below are accepted on compiled `5708be0`.** The earlier `5ca0487` root commit contains that milestone’s agent fixes. The English UI uses JSON catalogs. Not claimed: physical touch, IME, Safari, native 403/503, authenticated flows and production. The exact gates and the preserved failures are in [25](25-ux-verification.md).

Asana's list view and its [task actions and keyboard help](https://help.asana.com/s/article/task-actions?language=en_US) served as interaction inspiration. Workloom does not claim feature or shortcut parity. It uses its own commands, retry rules and limits. This page supersedes the 288px editor-column widening described in [65](65-inline-editor-layout.md). 65 retains the historical design; the [66](66-team-quick-start.md) walkthrough is maintained for current interaction guidance. The first night additions and their exact root matrix are recorded in [69](69-night-daily-ux.md); later live-refresh work is outside that checkpoint.

## Title editing

- In an editable row, clicking the visible task name opens the title editor in place. **Open details** and **Add subtask** are separate row actions.
- In a read-only row, the name opens the details drawer.
- In the title editor (and the other text editors), keys work as follows. While an IME is composing, Enter is ignored.

| Key | Effect |
| --- | --- |
| Enter | Saves the title. For a root task in section grouping, it also opens the next blank add row (see below) |
| Ctrl/Cmd+Enter | Saves only, with no next row |
| Shift/Alt+Enter | Does nothing |
| Escape | Closes the editor. A changed draft stays in the page's in-memory edit session, and reopening that cell resumes it |

- A next row needs all of the following: section grouping, a writable project, a root task (no parent), and a task that is inline-editable. Its section must be active, or it is the **No section** group. Otherwise Enter just saves and closes.
- If the title is unchanged, Enter sends nothing and goes straight to the next blank row.
- **Changed title.** Plain Enter opens the next blank row at once, as long as the editor still owned focus. It does not wait for the acknowledgement.
  - The update keeps its exact retained session.
  - If a quick draft is retained for another section, the row opens in that draft's section, which keeps the draft intact.
- **Ordinary pending continuation.** While that title save is pending, the page shows nothing extra: no recovery banner, no draft chip and no blocking popover. A success is announced once and does not move focus.
- **Failed or unknown outcome.** A page alert appears with **Resume**, which opens that task's details for recovery.

## Add rows

- Each section ends with an **Add task…** row. The section header's **+ Task** button opens the same title-first row.
- The top **New task** button also opens it, in **No section**, when the table is grouped by section. In Board, Graph, Gantt, Import or assignee grouping, it opens the full composer.
- The row contains a title input, **Add**, **More details** and **Collapse**. **More details** moves a typed draft into the full composer. It is disabled while any quick create is queued, pending or unconfirmed.
- An Enter on a blank title creates nothing and keeps focus.
- A row with no typed text and nothing queued closes on blur. Escape or Collapse closes the row and keeps a typed draft.

## Fast entry queue

In `useTaskCommands`, the page owns an editable buffer for the next title and an explicit, serialized create queue. Both outlive a collapsed or remounted add row.

- Enter validates the title, queues that exact session and parsed input, and synchronously clears the input for the next title. Focus stays in the row. A later acknowledgement never edits the new buffer and never takes focus back.
- Only the front entry reaches the existing create command. Nothing is posted until the person presses Enter. It also waits while any task update, archive or restore is still pending or unconfirmed, including the title save that opened this row.
- If another task's save is merely pending, the queued create just waits quietly. Only an unknown outcome adds a notice asking the person to resume that save's original editor first.
- On any failure the queue pauses. The popover shows **Submitted task: …** for the front entry.
  - **Retry** resends the same input object. The existing tracker reuses the original body and idempotency key.
  - **Discard rejected task** appears only after a known rejection. It removes that one entry.
  - An unknown outcome offers Retry but never Discard.
- While the queue is non-empty or the buffer holds typed text, the page registers a protected draft and a `beforeunload` warning. The queue and drafts live in memory only and do not survive a reload.

## Leaving a cell and neighbouring cells

- **Synchronous blur.** If focus moves to a known element outside the editor, a changed text field submits right away, before the next cell's click can replace the form. When the related target is null, such as after a window switch, the check is deferred and commits only if focus really left.
- **Choice editors.** They save on an explicit choice, never on blur.
  - Escape returns focus to the cell. Tab closes the picker and moves on in the tab order.
  - A real pointer press outside the cell closes the picker without a write. Focus stays where the person pressed, for example on the non-focusable project heading.
- **Fresh head before reopening.** A clicked cell is held rather than opened in two cases: while another task save is in flight, or while the list is refetching. `ProjectPage` records the list's `dataUpdatedAt` and the last command receipts at that moment. When the held work settles:
  - An unknown outcome keeps the cell closed.
  - The cell waits until every queued quick create has been sent, including a paused rejected front.
  - It also waits until no refetch is running. Then, for each confirmed receipt, the loaded row's `revision`, `participantsRevision` and, for the same package, `workPackageRevision` must be at least the confirmed values. If the row left the list, a newer list load is enough.
  - A failed list refresh shows its error instead. The person reopens the cell after an explicit retry.
  - The cell opens only if focus has not moved elsewhere. It then edits the row as reloaded, at the confirmed revision.

## Stable grid geometry

- **Normal task rows.** Each is one fixed line: a 40px CSS cell height plus the border, which measures 41px. Text does not wrap and is truncated. Opening, typing in or closing an editor never changes column widths, the header or row heights.
- **Table position.** Normal editing and an ordinary pending save do not move the table on the page; the pending continuation shows no page banner. There is one exception: a real unknown custom-field result adds a page-level notice, which keeps the submission open and can move the table down. Only that stage is exempt from the native table-position check; its width, header and row checks still apply.
- The title column is `clamp(280px, 42cqw, 460px)` of the table's scroll container. The table's minimum width is that clamp plus the fixed widths of the other columns.
- Row actions are an overlay on the right of the title cell. They take no pointer events until the row is hovered or has focus. On devices without hover they stay visible, with reserved padding.
- Errors, Retry, estimate help and **More details**/**Collapse** appear in `CellPopover`. It uses the browser top layer where available, is positioned against the viewport, and takes neither layout space nor focus.
  - While a later dialog (such as the task drawer or a field dialog) covers its cell, it is only hidden. Its content, command and actions stay mounted, and they come back on the same cell when that dialog closes.
  - The explicit one-time reveal inside the table scrollport from 65 remains.
- **Unconfirmed custom field values.** The cell feedback opens below the cell, away from page notices. It shows Retry and **Review in details** (the existing `inlineFields.review` action), both reachable with a normal click.
  - Opening details neither retries nor discards the command.
  - The exact retry stores one value revision.

## Choice pickers

The shared `ChoicePicker` replaces native selects in several places:

- inline Status, Priority and Assignee (searchable);
- custom single-select (enum) values, and custom person values that hold no person or one person. A value with several people is edited in details, and so are the other complex custom types;
- the drawer Status and Assignee (searchable);
- the Group and Sort toolbar controls;
- the Week and Person time controls.

How it behaves:

- **Menu placement.** The menu is portalled into the nearest modal dialog, or into the page body. It is clamped to the viewport and to that dialog.
- **Search.** Search appears when requested or when there are more than seven options. Matching ignores case and accents.
- **Keyboard.** Arrow keys, Home/End and PageUp/PageDown move through options. Typing jumps to matching options as in a native select. Escape closes only the menu. Tab continues from the trigger. A modified Enter is left to the surrounding form.
- **Dismissal.** An outside press or a focus move closes the menu without a write. Only an explicit choice sends one update.

## Week, person and budgets

- **Week and Person** are compact pickers. The week starts as **Choose a week explicitly**. Time writes still need an explicitly selected period, and no week is ever inferred. The person picker changes only whose hours are shown. It does not change the task list or the acting user.
- The **Loaded team budget** footer sums the current package estimates of loaded tasks, counting each package once. A filtered or incomplete scope adds **Budget covers loaded tasks only.** (see [63](63-table-guidance.md)). It is not the pinned report baseline.
- On the [67](67-asana-style-demo.md) demo, the footer shows the current 123h. The pinned report has its own baseline and plan/fact totals.

## Night addition: moving one root task to a section

**Accepted in the bounded first night UI checkpoint `5708be0`.** The row action **Move to section** opens the same guarded inline choice editor. It applies only to an editable ordinary root task; a detail/additional subtask remains under its parent, and meeting, archived and read-only rows cannot use it. Choices are active sections in project order plus **No section**. An archived or unavailable current section stays labelled but is not a new destination.

An explicit choice sends only the existing task `sectionId` update with its current revision and retained command rules. It does not move the task to another project, reparent it or change status, participants, package estimate, plans or facts. On confirmation the destination section is expanded and the move is announced. Rejection or unknown outcome uses the same retained recovery and exact retry; there is no section drag and drop. A real mobile title/action overlap was caught by the legacy native gate. For `5708be0`, row actions reserve their actual rendered width in the title row in every pointer mode, superseding the absolute-overlay rule in the historical geometry section above. The section editor itself remains an overlay. Row height and column geometry remain fixed; all 39 legacy native assertions passed unchanged. Test/browser acceptance and the preserved RED belong to [69](69-night-daily-ux.md) and [25](25-ux-verification.md).

## Acceptance summary

Root gates on compiled `5ca0487` (Node 24) all passed:

- web build, global lint/boundaries/localization, and root/E2E types;
- the full web suite, **1,050 cases in 137 suites**;
- the native [spec](../tests/e2e/asana-table-interactions.spec.ts), **39/39**: 13 journeys at 1440, 1024 and 390 in installed Chrome;
- a focused native recovery run, **3/3** at 1440, 1024 and 390. A custom-field value was committed but its ACK was lost. **Review in details**, inside the cell popover, then led through the task and value dialogs to the same original retry;
- read-only checks of the actual demo, including an explicitly selected week with the plan and actual dialogs.

Earlier REDs and rejected intermediate runs are preserved in [25](25-ux-verification.md): a stale head 409 in 3 of 30 cases, a premature picker after the ACK, and the error popover occluding Open. The backend was not rerun, and old-tab and runtime restarts were not repeated.
