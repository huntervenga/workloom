# Shared calls removed (24 October 2026)

The "shared call" feature (shared activities with a call roster and attendance confirmation) was taken out before launch: it was hard to understand and its panel was not reliable in daily use.

- Removed: the "Shared call" entry in the project Add menu, the task-pane panel, the `/shared-activity*` API routes, the `createSharedActivityApplication` and domain service, their tests and the English strings.
- Kept: task collaborators work as before and each person's time is counted as an ordinary task Fact (the assignee). Tables `shared_activities*` stay in the database (migrations are additive only) and are empty locally; the read-side code in reports, duplication and planning checks is inert without rows.
- Week 43: the five "Daily standup" tasks and "Team call" were permanently deleted (`scripts/purge.mjs`), the "General" section was archived. Backup before the change: `wl_before_remove_calls.dump` (local scratch).
- Docs [102](102-shared-activities-and-summary-templates.md) and [104](104-linked-section-templates-and-shared-effort.md) describe the removed feature and are historical. Linked section summary templates in 104 are not affected.
- Open question for later: one common way to share a task's time between collaborators.
