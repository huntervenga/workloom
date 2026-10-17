import type { AttendanceDto, MeetingDto, MeetingPlanPreviewInput, MembershipDto, TaskDto, WorkspaceDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, failure, installFakeApi, ok, project, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, STAMP, TASK_ID, lostResponse, rootPath, task } from '../planning/test/fixtures';
import { tableRoutes } from '../work-categories/test/fixtures';
import { MeetingDrawer } from './MeetingDrawer';
import { choosePicker, outcomeOption } from './test/pickers';
import { useMeetingWorkspace, type MeetingTab } from './useMeetingWorkspace';

const MEETING = 'ab000000-0000-4000-8000-000000000021';
const extra = (n: number, name: string): MembershipDto => ({ id: `c0000000-0000-4000-8000-00000000000${n}`, workspaceId: alpha.id, userId: `5555555${n}-5555-4555-8555-555555555555`, displayName: name, role: 'member' });
// Five current attendees (the actor first) and one person removed from the roster before any fact.
const members: MembershipDto[] = [...alphaMembers, extra(4, 'Дина Пятая'), extra(5, 'Егор Шестой'), extra(6, 'Удалённый участник')];
const active = members.slice(0, 5);
const removed = members[5];
const meetingTask: TaskDto = { ...task, meetingId: MEETING, title: 'Еженедельная встреча шести', estimateMinutes: 300, participants: active.map(m => ({ membershipId: m.id, role: 'assignee' as const, active: true, revision: 1 })) };
function meeting(overrides: Partial<MeetingDto> = {}): MeetingDto {
  return { id: MEETING, workspaceId: alpha.id, projectId: PROJECT_ID, taskId: TASK_ID, workPackageId: task.workPackageId, revision: 1, participantsRevision: 2, plannedPeriodId: PERIOD_A, plannedStartAt: STAMP, timezone: 'UTC', plannedDurationMinutes: 60, organizerMembershipId: MEMBER_ID, state: 'scheduled', actualStartAt: STAMP, actualDurationMinutes: 60, joinUrl: null, recordingUrl: null, summaryUrl: null, summaryText: null, scheduleFrozen: false, hasPostedAttendance: false, createdAt: STAMP, updatedAt: STAMP, ...overrides };
}
const rows: AttendanceDto[] = members.map((m, i) => ({ id: `ac000000-0000-4000-8000-00000000002${i + 1}`, workspaceId: alpha.id, meetingId: MEETING, taskId: TASK_ID, membershipId: m.id, revision: 1, rosterActive: m.id !== removed?.id, status: 'unknown', postingState: 'unconfirmed', minutes: null, confirmedMeetingRevision: null, workLog: null }));
const path = `${rootPath}/tasks/${TASK_ID}`;
const hash = 'c'.repeat(64);
function previewFor(input: MeetingPlanPreviewInput) {
  return ok({ meetingId: MEETING, periodId: PERIOD_A, meetingRevision: 1, participantsRevision: 2, workPackageRevision: 1, periodRevision: 1, previewHash: hash, rows: input.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, commitment: null, expectedCommitmentRevision: null, allocations: [{ taskId: TASK_ID, minutes: row.plannedMinutes ?? 0 }], unallocatedMinutes: 0 })) });
}
function routes(current: MeetingDto = meeting(), extraRoutes: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${path}`]: () => ok(meetingTask), [`GET ${path}/meeting`]: () => ok(current), [`GET ${path}/attendance`]: () => ok(rows), [`POST ${path}/meeting-plan-preview`]: request => previewFor(request.body as MeetingPlanPreviewInput), ...extraRoutes };
}
function mountDrawer({ role = 'owner', tab = 'plan' }: { role?: WorkspaceDto['role']; tab?: MeetingTab } = {}) {
  let select: (next: MeetingTab) => void = () => undefined;
  function Example() {
    const controller = useMeetingWorkspace(anna.id, alpha.id, PROJECT_ID);
    const [target, setTarget] = useState<{ tab: MeetingTab }>({ tab });
    select = next => setTarget({ tab: next });
    return <MeetingDrawer controller={controller} initialIntent={target} initialTab={target.tab} actorId={anna.id} workspace={{ ...alpha, role }} project={project(alpha.id, PROJECT_ID, 'Project')} members={members} taskId={TASK_ID} task={meetingTask} open onClose={() => undefined} />;
  }
  return { ...renderFieldUi(<MemoryRouter><Example /></MemoryRouter>), select: (next: MeetingTab) => act(() => select(next)) };
}
const writes = (calls: FakeRequest[]) => calls.filter(call => call.method !== 'GET');
const card = (name: string) => screen.getByRole('checkbox', { name }).closest('div') as HTMLElement;
const hours = (name: string) => within(card(name)).getByLabelText('Meeting planned hours');
const selectEveryone = 'Select everyone you can plan · 1h each';

describe('fast explicit plan preparation for a shared call', () => {
  it('drafts every currently allowed attendee at meeting duration, keeps typed hours, and sends nothing before explicit Preview and Apply', async () => {
    let applied: unknown = null;
    const { calls } = installFakeApi(routes(meeting(), { [`POST ${path}/meeting-plan`]: request => { applied = request.body; return ok({ meetingId: MEETING, periodId: PERIOD_A, commitments: [] }); } }));
    const { user } = mountDrawer();
    const own = active[0]?.displayName ?? '';
    await user.click(await screen.findByRole('checkbox', { name: own }));
    await user.clear(hours(own)); await user.type(hours(own), '2');
    expect(screen.getByText('Selected: 1 of 5')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: selectEveryone }));
    for (const person of active) expect(screen.getByRole('checkbox', { name: person.displayName })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: removed?.displayName ?? '' })).not.toBeInTheDocument();
    expect(hours(own)).toHaveValue('2');
    expect(hours(active[4]?.displayName ?? '')).toHaveValue('1:00');
    expect(screen.getByText('Selected: 5 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: selectEveryone })).toBeDisabled();
    expect(writes(calls)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Preview personal plans' }));
    await screen.findByRole('heading', { name: 'Review before applying' });
    const preview = calls.find(call => call.path.endsWith('/meeting-plan-preview'));
    expect(preview?.body).toEqual({ expectedMeetingRevision: 1, rows: active.map((person, i) => ({ membershipId: person.id, plannedMinutes: i === 0 ? 120 : 60 })) });
    expect(preview?.headers.get('Idempotency-Key')).toBeNull();
    expect(calls.some(call => call.path.endsWith('/meeting-plan'))).toBe(false);

    // Replacing typed hours is a separate, explicit draft action that discards the stale preview.
    await user.click(screen.getByRole('button', { name: 'Reset 1 edited plan to 1h' }));
    expect(hours(own)).toHaveValue('1:00');
    expect(screen.queryByRole('heading', { name: 'Review before applying' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply personal plans' })).toBeDisabled();
    expect(calls.some(call => call.path.endsWith('/meeting-plan'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Preview personal plans' }));
    await screen.findByRole('heading', { name: 'Review before applying' });
    await user.click(screen.getByRole('button', { name: 'Apply personal plans' }));
    await waitFor(() => expect(applied).not.toBeNull());
    expect(applied).toEqual({ expectedMeetingRevision: 1, previewHash: hash, rows: active.map(person => ({ membershipId: person.id, plannedMinutes: 60, expectedCommitmentRevision: null })) });
    expect(calls.find(call => call.path.endsWith('/meeting-plan'))?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives a self-only member no way to select peers', async () => {
    const { calls } = installFakeApi(routes());
    const { user } = mountDrawer({ role: 'member' });
    const own = active[0]?.displayName ?? '';
    await user.click(await screen.findByRole('checkbox', { name: own }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: selectEveryone })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview personal plans' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedMeetingRevision: 1, rows: [{ membershipId: MEMBER_ID, plannedMinutes: 60 }] });
  });

  it('keeps a viewer read-only in both bulk paths', async () => {
    const { calls } = installFakeApi(routes());
    const ui = mountDrawer({ role: 'viewer' });
    await screen.findByRole('button', { name: 'Preview personal plans' });
    expect(screen.queryByRole('button', { name: selectEveryone })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview personal plans' })).toBeDisabled();
    ui.select('attendance');
    await screen.findByRole('region', { name: 'Individual attendance' });
    expect(screen.queryByRole('region', { name: 'Team attendance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Everyone attended · prepare review' })).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it('suggests no bulk plan or full attendance for a cancelled meeting', async () => {
    const { calls } = installFakeApi(routes(meeting({ state: 'cancelled', actualStartAt: null, actualDurationMinutes: null })));
    const ui = mountDrawer();
    const bulk = await screen.findByRole('button', { name: selectEveryone });
    expect(bulk).toBeDisabled();
    await ui.user.click(bulk);
    expect(screen.getByText(/This meeting is cancelled, so everyone is not selected at once/)).toBeInTheDocument();
    for (const person of active) expect(screen.getByRole('checkbox', { name: person.displayName })).not.toBeChecked();
    ui.select('attendance');
    const full = await screen.findByRole('button', { name: 'Everyone attended · prepare review' });
    expect(full).toBeDisabled();
    expect(screen.getByText(/A cancelled meeting cannot be prepared as attended/)).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it('locks both bulk actions while a plan apply is unknown, then retries exactly the original request', async () => {
    const gate = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi(routes(meeting(), { [`POST ${path}/meeting-plan`]: () => ++attempts === 1 ? gate.promise : ok({ meetingId: MEETING, periodId: PERIOD_A, commitments: [] }) }));
    const ui = mountDrawer();
    await ui.user.click(await screen.findByRole('button', { name: selectEveryone }));
    await ui.user.click(screen.getByRole('button', { name: 'Preview personal plans' }));
    await screen.findByRole('heading', { name: 'Review before applying' });
    await ui.user.click(screen.getByRole('button', { name: 'Apply personal plans' }));
    await waitFor(() => expect(attempts).toBe(1));
    await act(async () => gate.lose());
    expect(screen.getByRole('button', { name: selectEveryone })).toBeDisabled();
    ui.select('attendance');
    expect(await screen.findByRole('button', { name: 'Everyone attended · prepare review' })).toBeDisabled();
    ui.select('plan');
    await ui.user.click(await screen.findByRole('button', { name: 'Retry original save' }));
    await waitFor(() => expect(attempts).toBe(2));
    const applies = calls.filter(call => call.path.endsWith('/meeting-plan'));
    expect(applies[1]?.body).toEqual(applies[0]?.body);
    expect(applies[1]?.headers.get('Idempotency-Key')).toBe(applies[0]?.headers.get('Idempotency-Key'));
    expect(calls.filter(call => call.path.endsWith('/meeting-plan-preview'))).toHaveLength(1);
  });

  it('keeps every drafted plan after a stale-preview rejection and never re-previews or re-applies on its own', async () => {
    const { calls } = installFakeApi(routes(meeting(), { [`POST ${path}/meeting-plan`]: () => failure(409, 'PREVIEW_STALE', 'stale') }));
    const ui = mountDrawer();
    await ui.user.click(await screen.findByRole('button', { name: selectEveryone }));
    await ui.user.click(screen.getByRole('button', { name: 'Preview personal plans' }));
    await screen.findByRole('heading', { name: 'Review before applying' });
    await ui.user.click(screen.getByRole('button', { name: 'Apply personal plans' }));
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/meeting-plan'))).toHaveLength(1));
    // A known rejection releases the command; nothing is resent until the person acts again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply personal plans' })).toBeEnabled());
    for (const person of active) expect(hours(person.displayName)).toHaveValue('1:00');
    expect(calls.filter(call => call.path.endsWith('/meeting-plan-preview'))).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith('/meeting-plan'))).toHaveLength(1);
  });
});

describe('team attendance first for owners and admins', () => {
  it('orders actual details, team attendance, then the single-person editor, and still confirms one chosen person', async () => {
    const { calls } = installFakeApi(routes(meeting(), { [`POST ${path}/attendance/confirm`]: () => ok({ meeting: meeting({ hasPostedAttendance: true }), attendances: rows }) }));
    const ui = mountDrawer({ tab: 'attendance' });
    const team = await screen.findByRole('region', { name: 'Team attendance' });
    const actual = screen.getByRole('region', { name: 'Actual meeting details' });
    const single = screen.getByRole('region', { name: 'Individual attendance' });
    expect(actual.compareDocumentPosition(team) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(team.compareDocumentPosition(single) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const colleague = active[1]?.displayName ?? '';
    await choosePicker(ui.user, document.body, 'Whose attendance', colleague);
    await choosePicker(ui.user, document.body, 'Attendance outcome', outcomeOption.absent);
    await ui.user.click(screen.getByRole('button', { name: "Confirm selected person's attendance" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedMeetingRevision: 1, periodId: PERIOD_A, rows: [{ attendanceId: rows[1]?.id, expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: 'absent', attributionBasis: 'planned_absence', minutes: 0, reason: null }] });
  });

  it('leaves a single-person draft alone when preparing full attendance, and confirms only the prepared team rows', async () => {
    const { calls } = installFakeApi(routes(meeting(), { [`POST ${path}/attendance/confirm`]: () => ok({ meeting: meeting({ hasPostedAttendance: true }), attendances: rows }) }));
    const ui = mountDrawer({ tab: 'attendance' });
    const comment = await screen.findByLabelText('Attendance comment (optional)');
    await ui.user.type(comment, 'Мой отдельный комментарий');
    await ui.user.click(screen.getByRole('button', { name: 'Everyone attended · prepare review' }));
    const team = screen.getByRole('region', { name: 'Team attendance' });
    expect(within(team).getByText(/4 people are prepared for review\. Nothing is saved yet\. 1 person with your own unsent changes was left as is/)).toBeInTheDocument();
    expect(within(team).getByRole('checkbox', { name: active[0]?.displayName ?? '' })).not.toBeChecked();
    expect(screen.getByLabelText('Attendance comment (optional)')).toHaveValue('Мой отдельный комментарий');
    expect(screen.getByLabelText('Attendance outcome')).toHaveTextContent(outcomeOption.unknown);
    expect(writes(calls)).toHaveLength(0);
    await ui.user.click(within(team).getByRole('button', { name: 'Confirm team attendance' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect((writes(calls)[0]?.body as { rows: { attendanceId: string; status: string }[] }).rows).toEqual(rows.slice(1, 5).map(row => expect.objectContaining({ attendanceId: row.id, status: 'present', minutes: 60 })));
    const success = await screen.findByText('Team attendance saved.');
    expect(success).toHaveAttribute('role', 'status');
    expect(screen.getAllByText('Team attendance saved.')).toHaveLength(1);
    expect(team.nextElementSibling).toBe(success);
    expect(success.nextElementSibling).toBe(screen.getByRole('region', { name: 'Individual attendance' }));
    expect(screen.getByLabelText('Attendance comment (optional)')).toHaveValue('Мой отдельный комментарий');
  });
});
