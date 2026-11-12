# 134 · Member time-off requests for today and past dates

**What it is.** Members (role `member`) can ask for time off that starts today or earlier, for example a sick day or an emergency. Before this change the earliest date a member could pick was tomorrow, and the server rejected anything earlier with "Started and past absence days are locked." Owners and admins could already record past absences with a reason ([118](118-recording-historical-absences.md), [119](119-systemic-administrative-time-off.md)); that path is unchanged.

## Rules

- **Always pending.** A member's new request whose start date is today or earlier (the member's local date, from the database clock) is saved as `pending` with no charged days, even for an absence type that normally needs no approval. Future requests behave as before: pending or approved according to the type.
- **No reason from the member.** The private note carries any context. Under the dates the form says "Requests that start today or earlier are sent to an owner or admin for approval."
- **How far back.** No new limit. The existing member checks still apply: dates inside the member's employment and accounting start, a policy that covers the year, no overlap with another pending or approved request, and no archived type.
- **Approval.** Unchanged: the request appears in the approver's Inbox and in Time off → Requests. Approving days that have started needs an administrator reason. A fully elapsed request is approved as recorded history (`historicalAbsenceRecording` in the audit), with the advisory balance warnings described in 118/119.
- **Started days stay read-only for members.** The start date and note of a started request cannot change; an ongoing request's end date can move to today or later. Moving a future request's start to today or earlier is still rejected: cancel it and submit a new request.
- **Withdrawal.** A member can cancel their own pending request at any time, including after its dates. The server already allowed this; the request list now shows **Cancel request** for it, with "An owner or admin still needs to approve this request…".
- **Same for every channel.** The rule lives in the domain service (`packages/domain/src/leave/service.ts`: `create`, request preview and `proposed`), so the app's time-off HTTP routes follow it too (the public API and MCP have no time-off request tools). No migration and no contract change.

## Checks (12 November 2026, local)

- PostgreSQL integration (a throwaway local PostgreSQL 18.4 cluster; the project targets 17): `tests/integration/leave.test.ts` 21/21, including two new tests (pending for an approval-free type, approver Inbox, approval needs a reason, audit flag, withdrawal; employment/accounting bounds, another person, overlap, read-only started days). Against the original service code exactly the three new or changed tests failed. All leave and inbox integration files: 40/40. In `leave-historical-create.test.ts` one assertion changed: a demoted member's past request is now pending and the member cannot approve it.
- Web: time-off and inbox tests 103/103 in 13 files (a new form test, two new request-list tests, one updated page assertion).
- Unit: the whole backend unit project 2546/2546 in 171 files (leave domain, contracts, API routes and access: 106 in 13).
- Static (Node 24.19.0): workspace typechecks, root `tsc` (after building `apps/worker`: a fresh checkout cannot resolve `@workloom/worker` in two worker integration tests), ESLint with `apps/web/public/**` ignored as in `predeploy`, boundaries and localization pass. Plain `npm run lint` stops on 6,363 errors in the committed built assets under `apps/web/public`, which this change does not touch.
- Not checked: a real browser run, the full web suite, production.
