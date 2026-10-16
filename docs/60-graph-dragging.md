# Personal graph dragging

The Diagram already uses React Flow’s native node dragging: drag the card background or project/status text, then choose **Save my layout** to persist the personal arrangement. A short localized instruction now exposes that workflow. Task-title and blocker buttons keep their existing `nodrag` behavior. The list’s position controls and Diagram keyboard controls remain available.

This is personal view state. Viewers with current task read access can arrange their own graph. Dragging creates a retained local layout draft; it does not save automatically, change dates/estimates, edit dependencies, or change another person’s arrangement. Explicit full-set Save retains stored positions hidden from the selected graph. Discard restores the saved arrangement. Leaving with an unsaved layout uses the existing Stay/Leave guard. Pending or unconfirmed submissions keep the original key/body and lock movement until an exact retry resolves them.

The underlying implementation is [GraphCanvas](../apps/web/src/features/dependencies/GraphCanvas.tsx), [GraphView](../apps/web/src/features/dependencies/GraphView.tsx), and [the dependency workspace controller](../apps/web/src/features/dependencies/useDependencyWorkspace.ts). This document clarifies existing dependency-graph dragging. Historical references to deferred pointer drag/resize do not constitute a new Gantt capability; [P4b](18-p4b-contract.md) remains separate. [P4a](17-p4-contract.md) defines personal full-set saves and finite fractional top-left coordinates within ±100,000.

## Verification

[The native dragging browser cases](../tests/e2e/graph-dragging.spec.ts) run the same bounded phases at 1440×1000 and 390×844 using Playwright **mouse** input. Mobile width is not physical-touch acceptance. Each accepted phase writes evidence immediately, so a later failure cannot imply that unexecuted stages passed.

1. Record actual native pointer down/up and actual DOM viewport zoom/translation; prove graph-coordinate movement at non-unit zoom, no task opening and no automatic HTTP write.
2. Save, reload and reselect the explicit root through Tasks; compare exact coordinates and preserve a hidden stored node. This proves a fresh reopen after reload, not persisted root selection. Capture the reopened Diagram at non-unit zoom.
3. Prove Discard and cross-project Stay preserve the appropriate local/server state.
4. Hold a genuinely committed response, try movement while pending, lose its acknowledgement, try movement while unknown, and retry the identical body/key. Preserve the real replay and hidden positions.
5. Leave a new unsaved move for a cross-project task and prove saved coordinates are unchanged.
6. Use a separate supported fixture near both coordinate limits. Record the actual DOM result before asserting finite valid coordinates and controller/save agreement. No fixture reset conceals a boundary result. Capture the actual boundary Diagram before assertions.
7. Compare task and blocking-policy DTOs before/after and reject unrelated browser writes or page errors.

The final actual Chromium run passed **2/2 in 34.1 seconds** against compiled `d97041c`, entry `/assets/index-CzXNmADz.js`, SHA256 `2de882dce729eb710f3f73f904345ac4c6920a07767ef0ffe7222e86d8023561`. All listed phases ran at both widths, using fresh additive projects in the existing synthetic QA workspace. Explicit Save and its exact retry were real API/PostgreSQL writes. Task and policy DTOs remained unchanged; browser writes were limited to the expected personal-layout saves/retry. Physical touch, actor switching and arbitrary stored graphs are not claimed.

Two earlier complete attempts remain distinct failures: the first assumed the entire mouse-down/up delta counted, whereas XYFlow anchors only after its native drag threshold; the second equated full-precision API doubles with browser-rounded CSSOM coordinates. The corrected oracle records both mouse and pointer events, observes an active settled drag anchor, and retains the original scaled-delta precision. Request body → stored DTO remains exact. A detached, unmounted style declaration provides the browser serialization used for exact rendered-coordinate checks; it does not round or mutate API data or app nodes. No production drag/controller code changed.

The boundary fixture began at `(99990, -99990)`. The real outward drag retained valid intermediate coordinates: desktop `(99999, -99999)` at zoom `1.66667`; mobile rendered `(99998.8984375, -99998.8984375)` at zoom `1.125`. Both offered explicit Save and matched the stored layout through browser serialization. This is the tested native movement sequence, not a general hard-clamp or physical-touch claim.

All 14 served assets remained exact from **13:44:09.910 to 13:50:50.750 UTC** with strict database/schema readiness. Runtime doctor confirmed helper-owned healthy PostgreSQL/API/web and worker OFF. No build, restart, migration or queue/worker operation occurred in the exclusive window. The first two failed logs/traces, final passed log/traces, phase JSON and four Diagram screenshots are preserved separately under `workloom-evidence/v10-graph-dragging/manifest.json` in the visualization workspace. Current acceptance belongs in [the verification journal](25-ux-verification.md); source checks and compiled browser acceptance remain separate.
