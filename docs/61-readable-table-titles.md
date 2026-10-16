# Readable table titles — preparation

Status: source-only browser preparation. TaskTable is unchanged; no fixture has been created and no browser case has run for this slice. Implementation and compiled baseline execution require the coordinated parent window.

## Evidence and proposed scope

The current accepted due-sort desktop frame in `test-results/v9-task-sorting-corrected/.../project-due-sorting-desktop.png` shows similarly prefixed parent/child names clipped before their distinguishing suffix. Current TaskTable gives its title column 320px, with Graph selection, hierarchy disclosure, completion, rename, child count, badges and Add subtask sharing that space. Visual indent grows by 20px at every depth. This allows deep rows and combined metadata to consume the available title width.

The historical Studio frame `workloom-evidence/v2-personal-columns/desktop-table.png` already clips **Run the weekly workflow checks**. That older checkpoint predates the current completion/Graph/rename gutters; it establishes a realistic title example, not current geometry. Other existing Studio titles include **Review the mobile experience** and **Confirm the team working agreement**.

The proposed later fix is restricted to title-cell layout: wrap full titles and unbroken tokens, keep short plain rows compact, place context/badges/counts on a wrapping secondary line, and cap visual indent while preserving actual tree membership/depth and accessible parent context. No tree sorting, selection, completion, command, title-width preference or backend change is proposed. The final indentation/layout parameters remain subject to measured baseline and implementation review.

## Prepared browser gate

`tests/e2e/task-table-title-readability.spec.ts` contains two native Chromium cases, desktop 1440×1000 and mobile 390×844. A single additive 12-task QA project is reused between viewports and subsequent RED/GREEN runs through a private `.local/qa/task-title-<key>.json` manifest. The fixture uses supported APIs only when explicitly executed. An interrupted setup refuses silent reseeding; an existing manifest must match the current origin. Studio and old QA projects remain untouched.

The fixture contains one nine-level ordinary detail chain (depths 0–8), actual Studio title examples, realistic sentences around 80 characters and one unbroken token. The deep leaf combines a legitimate cross-section context with an unsent description Draft badge; parents expose their real loaded child counts. It does not invent an ordinary-task/meeting combination or force archived rows through unsupported filters. Three independent plain rows include a short compactness control.

The browser opens the deep task through its native title button, retains a real unsent description on Close, selects its separate Graph checkbox and measures all actual rendered title text ranges. Assertions cover positive title width, no clipped text range, no overlap with native controls, no global horizontal overflow and a maximum 52px height for the short plain row. Local table horizontal scrolling remains allowed. Geometry JSON and full-page screenshots are written before the assertions, so the original RED remains reviewable. A native keyboard rename/open/no-op Save round trip checks the existing focus path without submitting a mutation. All browser API writes after setup must remain zero.

No CSS class-name or jsdom geometry assertion substitutes for these native measurements. The baseline is expected to expose clipping/deep indentation; it has not yet been executed. Physical IME, touch-device input, archived/meeting presentation, all possible title lengths and every column configuration are not claimed by these two cases.

## Verification

Source root TypeScript noEmit and scoped ESLint passed. Playwright source collection found exactly two Chromium cases; no browser case was executed. Local documentation links and whitespace checks passed. No runtime, database, compiled assets or TaskTable implementation has been changed. Browser baseline and any later corrected run must be reported separately with the compiled checkpoint and exact fixture identity.

Related contracts: [contextual toolbar](59-contextual-project-toolbar.md), [inline rename](39-inline-task-title.md), [assignee grouping](50-assignee-grouping.md), [section disclosure](45-task-section-collapse.md).
