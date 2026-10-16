# Personal graph dragging

The Diagram already uses React Flow’s native node dragging: drag the card background or project/status text, then choose **Save my layout** to persist the personal arrangement. A short localized instruction now exposes that workflow. Task-title and blocker buttons keep their existing `nodrag` behavior. The list’s position controls and Diagram keyboard controls remain available.

This is personal view state. Viewers with current task read access can arrange their own graph. Dragging creates a retained local layout draft; it does not save automatically, change dates/estimates, edit dependencies, or change another person’s arrangement. Explicit full-set Save retains stored positions hidden from the selected graph. Discard restores the saved arrangement. Leaving with an unsaved layout uses the existing Stay/Leave guard. Pending or unconfirmed submissions keep the original key/body and lock movement until an exact retry resolves them.

The underlying implementation is [GraphCanvas](../apps/web/src/features/dependencies/GraphCanvas.tsx), [GraphView](../apps/web/src/features/dependencies/GraphView.tsx), and [the dependency workspace controller](../apps/web/src/features/dependencies/useDependencyWorkspace.ts). This document clarifies existing dependency-graph dragging. Historical references to deferred pointer drag/resize do not constitute a new Gantt capability; [P4b](18-p4b-contract.md) remains separate. [P4a](17-p4-contract.md) defines personal full-set saves and finite fractional top-left coordinates within ±100,000.

## Verification prepared

[The native dragging browser cases](../tests/e2e/graph-dragging.spec.ts) run the same bounded phases at 1440×1000 and 390×844 using Playwright **mouse** input. Mobile width is not physical-touch acceptance. Each accepted phase writes evidence immediately, so a later failure cannot imply that unexecuted stages passed.

1. Record actual native pointer down/up and actual DOM viewport zoom/translation; prove graph-coordinate movement at non-unit zoom, no task opening and no automatic HTTP write.
2. Save, reload and reselect the explicit root through Tasks; compare exact coordinates and preserve a hidden stored node. This proves a fresh reopen after reload, not persisted root selection. Capture the reopened Diagram at non-unit zoom.
3. Prove Discard and cross-project Stay preserve the appropriate local/server state.
4. Hold a genuinely committed response, try movement while pending, lose its acknowledgement, try movement while unknown, and retry the identical body/key. Preserve the real replay and hidden positions.
5. Leave a new unsaved move for a cross-project task and prove saved coordinates are unchanged.
6. Use a separate supported fixture near both coordinate limits. Record the actual DOM result before asserting finite valid coordinates and controller/save agreement. No fixture reset conceals a boundary result. Capture the actual boundary Diagram before assertions.
7. Compare task and blocking-policy DTOs before/after and reject unrelated browser writes or page errors.

These cases are source preparation. Browser execution, actual pointer behavior, coordinate-boundary acceptance and physical touch are **not yet verified for this slice**. The existing graph/controller geometry and save contracts are unchanged. No build, runtime, API or database mutation is part of this source-only change. Current browser evidence belongs in [the verification journal](25-ux-verification.md), separately from this preparation.
