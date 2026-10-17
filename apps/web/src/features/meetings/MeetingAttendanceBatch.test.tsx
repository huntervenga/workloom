import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttendanceDto, AttendanceWorkLogDto, MeetingDto, MembershipDto } from '@workloom/contracts';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { PACKAGE_ID, PERIOD_A, PROJECT_ID, STAMP, TASK_ID, lostResponse, rootPath } from '../planning/test/fixtures';
import { category } from '../work-categories/test/fixtures';
import { MeetingAttendanceBatch } from './MeetingAttendanceBatch';
import { useMeetingCommands } from './queries';
import type { AttendanceDraft } from './useMeetingWorkspace';

const MEETING = 'ab000000-0000-4000-8000-000000000001';
const members: MembershipDto[] = Array.from({ length: 6 }, (_, i) => ({ id: `c0000000-0000-4000-8000-00000000000${i + 1}`, workspaceId: alpha.id, userId: anna.id, displayName: `Участник ${i + 1}`, role: 'member' }));
function meeting(overrides: Partial<MeetingDto> = {}): MeetingDto {
  return { id: MEETING, workspaceId: alpha.id, projectId: PROJECT_ID, taskId: TASK_ID, workPackageId: PACKAGE_ID, revision: 3, participantsRevision: 1, plannedPeriodId: PERIOD_A, plannedStartAt: STAMP, timezone: 'Asia/Nicosia', plannedDurationMinutes: 60, organizerMembershipId: members[0]?.id ?? '', state: 'scheduled', actualStartAt: STAMP, actualDurationMinutes: 60, joinUrl: null, recordingUrl: null, summaryUrl: null, summaryText: null, scheduleFrozen: false, hasPostedAttendance: false, createdAt: STAMP, updatedAt: STAMP, ...overrides };
}
function attendance(): AttendanceDto[] {
  return members.map((member, i) => ({ id: `ac000000-0000-4000-8000-00000000000${i + 1}`, workspaceId: alpha.id, meetingId: MEETING, taskId: TASK_ID, membershipId: member.id, revision: i + 1, rosterActive: i < 5, status: 'unknown', postingState: 'unconfirmed', minutes: null, confirmedMeetingRevision: null, workLog: null }));
}
function posted(row: AttendanceDto): AttendanceDto {
  const workLog: AttendanceWorkLogDto = { id: 'ad000000-0000-4000-8000-000000000001', workspaceId: alpha.id, projectId: PROJECT_ID, taskId: TASK_ID, workPackageId: PACKAGE_ID, membershipId: row.membershipId, periodId: PERIOD_A, sourceKind: 'meeting_attendance', sourceKey: row.id, precision: 'occurrence', revision: 9, revisionId: 'ae000000-0000-4000-8000-000000000001', minutes: 60, state: 'active', reason: null, actorUserId: anna.id, recordedAt: STAMP, changeSeq: '20', category: category(), meetingId: MEETING, attendanceId: row.id, confirmedMeetingRevision: 1, attribution: { basis: 'actual_meeting', plannedStartAt: STAMP, actualStartAt: STAMP } };
  return { ...row, revision: 4, postingState: 'active', status: 'present', minutes: 60, confirmedMeetingRevision: 1, workLog };
}
const path = `POST ${rootPath}/tasks/${TASK_ID}/attendance/confirm`;
function mount({ current = meeting(), rows = attendance(), writable = true, blocked = false, initialDrafts = {} }: { current?: MeetingDto; rows?: AttendanceDto[]; writable?: boolean; blocked?: boolean; initialDrafts?: Record<string, AttendanceDraft> } = {}) {
  const onSaved = vi.fn();
  let replaceRows: (next: AttendanceDto[]) => void = () => undefined;
  function Harness() {
    const [drafts, setDrafts] = useState<Record<string, AttendanceDraft>>(initialDrafts);
    const [liveRows, setLiveRows] = useState(rows);
    replaceRows = setLiveRows;
    const [selected, setSelected] = useState<string[]>([]);
    const [open, setOpen] = useState(true);
    const commands = useMeetingCommands(anna.id, alpha.id, PROJECT_ID);
    return <><button onClick={() => setOpen(!open)}>Переключить панель</button><button onClick={() => commands.attendance.mutate({ taskId: TASK_ID, input: { expectedMeetingRevision: current.revision, periodId: PERIOD_A, rows: [{ attendanceId: rows[0]?.id ?? '', expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: 'absent', attributionBasis: 'planned_absence' }] } })}>Личная отправка</button>{open ? <MeetingAttendanceBatch meeting={current} periodLabel="Неделя команды" attendance={liveRows} members={members} drafts={drafts} onChange={setDrafts} selectedIds={selected} onSelectionChange={setSelected} mutation={commands.attendance} writable={writable} blocked={blocked} onSaved={onSaved} /> : null}</>;
  }
  render(<QueryClientProvider client={createQueryClient({ retry: false })}><Harness /></QueryClientProvider>);
  return { user: userEvent.setup(), onSaved, refetch: (next: AttendanceDto[]) => act(() => replaceRows(next)) };
}
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: "Select team members" }));
}
const outcomeLabels = { unknown: 'Skip · leave unconfirmed', present: 'Attended entire meeting', partial: 'Attended part of meeting', absent: 'Absent · 0 minutes', void: 'Void time entry' } as const;
/** Chooses one person's outcome through the shared picker, exactly as a pointer user does. */
async function outcome(user: ReturnType<typeof userEvent.setup>, person: string, value: keyof typeof outcomeLabels) {
  const label = `Attendance outcome: ${person}`;
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(within(screen.getByRole('listbox', { name: label })).getByRole('option', { name: outcomeLabels[value] }));
}

describe('controlled team attendance review and command boundary', () => {
  it('never posts on invitation, opening, or preparation; unknown stays skipped and removed roster is excluded', async () => {
    const { calls } = installFakeApi({});
    const { user } = mount();
    expect(screen.queryByLabelText("Attendance outcome: Участник 1")).not.toBeInTheDocument();
    await prepare(user);
    expect(screen.getAllByRole('combobox')).toHaveLength(5);
    expect(screen.getByLabelText("Attendance outcome: Участник 1")).toHaveTextContent(outcomeLabels.unknown);
    expect(screen.queryByText('Участник 6')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('reviews 3×60 + partial30 + absent0 and submits all five guarded sources in one actual request', async () => {
    const rows = attendance();
    const current = meeting();
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: current, attendances: rows.slice(0, 5) }) });
    const { user, onSaved } = mount({ rows, current });
    await prepare(user);
    await user.click(screen.getByRole('button', { name: "Mark selected as attended" }));
    await outcome(user, 'Участник 4', 'partial');
    await user.type(screen.getByLabelText("Time attended, hours: Участник 4"), '0:30');
    await outcome(user, 'Участник 5', 'absent');
    const review = screen.getByRole('region', { name: "Review team attendance" });
    expect(within(review).getByText(/Confirmed time: 3h 30m/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ expectedMeetingRevision: 3, periodId: PERIOD_A, rows: rows.slice(0, 5).map((row, i) => ({ attendanceId: row.id, expectedAttendanceRevision: row.revision, expectedWorkLogRevision: null, kind: 'confirm', status: i === 4 ? 'absent' : i === 3 ? 'partial' : 'present', attributionBasis: 'actual_meeting', minutes: i === 4 ? 0 : i === 3 ? 30 : 60, reason: null })) });
    expect(calls[0]?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(calls[0]?.body)).not.toContain('attendanceMode');
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it('clears only immutable submitted IDs when the server returns all current attendance rows', async () => {
    const rows = attendance(); const response = { meeting: meeting(), attendances: rows.slice(0, 5) };
    const { calls } = installFakeApi({ [path]: () => ok(response) });
    const { user, onSaved } = mount({ rows }); await prepare(user);
    for (let i = 2; i <= 5; i++) await user.click(screen.getByRole('checkbox', { name: `Участник ${i}` }));
    await outcome(user, 'Участник 1', 'absent');
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(calls[0]?.body).toMatchObject({ rows: [{ attendanceId: rows[0]?.id, status: 'absent' }] });
    expect(onSaved).toHaveBeenCalledWith(response, [rows[0]?.id]);
  });

  it('keeps absence zero distinct from skip and requires saved actual details for positive attendance', async () => {
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) });
    const { user } = mount({ current: meeting({ actualStartAt: null, actualDurationMinutes: null }) });
    await prepare(user);
    expect(screen.getByRole('button', { name: "Mark selected as attended" })).toBeDisabled();
    await outcome(user, 'Участник 1', 'present');
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled();
    expect(screen.getByText(/Save the meeting's actual start/)).toBeInTheDocument();
    await outcome(user, 'Участник 1', 'absent');
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ status: 'absent', minutes: 0, attributionBasis: 'planned_absence' }] });
  });

  it('requires reason for corrections and guards the latest recategorized work-log head independently', async () => {
    const rows = attendance();
    const first = rows[0]; if (!first) throw new Error('Missing fixture');
    rows[0] = posted(first);
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: rows.slice(0, 1) }) });
    const { user } = mount({ rows });
    await prepare(user);
    await outcome(user, 'Участник 1', 'partial');
    const minutes = screen.getByLabelText("Time attended, hours: Участник 1");
    await user.clear(minutes); await user.type(minutes, '0:30');
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled();
    await user.type(screen.getByLabelText("Attendance reason: Участник 1"), 'Уточнили участие');
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ expectedAttendanceRevision: 4, expectedWorkLogRevision: 9, kind: 'confirm', status: 'partial', minutes: 30, reason: 'Уточнили участие' }] });
    expect(JSON.stringify(calls[0]?.body)).not.toContain('category');
  });

  it('requires reason for void and rejects partial0 or duration overflow without any network write', async () => {
    const rows = attendance(); const first = rows[0]; if (!first) throw new Error('Missing fixture'); rows[0] = posted(first);
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) }); const { user } = mount({ rows }); await prepare(user);
    await outcome(user, 'Участник 1', 'void');
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled();
    await user.type(screen.getByLabelText("Attendance reason: Участник 1"), 'Ошибка');
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeEnabled();
    await outcome(user, 'Участник 1', 'partial');
    const minutes = screen.getByLabelText("Time attended, hours: Участник 1");
    for (const value of ['0', '1:01']) { await user.clear(minutes); await user.type(minutes, value); expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled(); }
    expect(calls).toHaveLength(0);
    await outcome(user, 'Участник 1', 'void');
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ kind: 'void', expectedAttendanceRevision: 4, expectedWorkLogRevision: 9, reason: 'Ошибка' }] });
  });

  it('allows truthful cancelled planned absence only with a reason and no invented actual start', async () => {
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) });
    const { user } = mount({ current: meeting({ state: 'cancelled', actualStartAt: null, actualDurationMinutes: null }) });
    await prepare(user); await outcome(user, 'Участник 1', 'absent');
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled();
    await user.type(screen.getByLabelText("Attendance reason: Участник 1"), 'Встреча отменена');
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ status: 'absent', minutes: 0, attributionBasis: 'planned_absence', reason: 'Встреча отменена' }] });
    expect(JSON.stringify(calls[0]?.body)).not.toContain('actualStartAt');
  });

  it('keeps page-owned batch edits across closing and retries lost responses with exactly the original body/key', async () => {
    const gate = lostResponse(); let attempts = 0;
    const response = { meeting: meeting(), attendances: attendance() };
    const { calls } = installFakeApi({ [path]: () => ++attempts === 1 ? gate.promise : ok(response) });
    const { user, onSaved } = mount(); await prepare(user); await user.click(screen.getByRole('button', { name: "Mark selected as attended" }));
    await user.click(screen.getByRole('button', { name: 'Переключить панель' }));
    await user.click(screen.getByRole('button', { name: 'Переключить панель' }));
    expect(screen.getByLabelText("Attendance outcome: Участник 1")).toHaveTextContent(outcomeLabels.present);
    await user.click(screen.getByRole('button', { name: "Confirm team attendance" }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(screen.getByRole('button', { name: "Select team members" })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Переключить панель' })); await act(async () => gate.lose());
    await user.click(screen.getByRole('button', { name: 'Переключить панель' }));
    expect(screen.getByText(/Retry sends the original request only/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Attendance outcome: Участник 1")).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Retry original team attendance" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(response, attendance().slice(0, 5).map(row => row.id)));
  });

  it('does not claim or retry a same-meeting single-person uncertain command', async () => {
    const gate = lostResponse(); const { calls } = installFakeApi({ [path]: () => gate.promise });
    const { user } = mount(); await prepare(user);
    await user.click(screen.getByRole('button', { name: 'Личная отправка' }));
    await waitFor(() => expect(calls).toHaveLength(1)); await act(async () => gate.lose());
    expect(screen.queryByRole('button', { name: "Retry original team attendance" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Select team members" })).toBeDisabled();
    expect(screen.getByRole('button', { name: "Confirm team attendance" })).toBeDisabled();
    expect(calls).toHaveLength(1);
  });

  it.each([{ writable: false }, { blocked: true }])('cannot prepare or send with denied permission/another held command: %j', async props => {
    const { calls } = installFakeApi({}); const { user } = mount(props);
    const prepareButton = screen.getByRole('button', { name: "Select team members" });
    expect(prepareButton).toBeDisabled(); await user.click(prepareButton); expect(calls).toHaveLength(0);
  });

  it.each([{ actualStartAt: STAMP, needsReason: false }, { actualStartAt: '2026-10-01T11:00:00.000Z', needsReason: true }])('compares effective occurrence attribution rather than unrelated meeting revisions: %j', async ({ actualStartAt, needsReason }) => {
    const rows = attendance(); const first = rows[0]; if (!first) throw new Error('Missing fixture'); rows[0] = posted(first);
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) });
    const { user } = mount({ rows, current: meeting({ actualStartAt, recordingUrl: 'https://example.com/recording' }) });
    await prepare(user);
    const submit = screen.getByRole('button', { name: "Confirm team attendance" });
    if (needsReason) { expect(submit).toBeDisabled(); await user.type(screen.getByLabelText("Attendance reason: Участник 1"), 'Уточнили фактическое начало'); }
    expect(submit).toBeEnabled(); await user.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ expectedMeetingRevision: 3, rows: [{ expectedAttendanceRevision: 4, expectedWorkLogRevision: 9, status: 'present', reason: needsReason ? 'Уточнили фактическое начало' : null }] });
  });

  it('retains the pending immutable snapshot without a second send on repeat clicks', async () => {
    const gate = deferred<Response>(); const { calls } = installFakeApi({ [path]: () => gate.promise });
    const { user } = mount(); await prepare(user); await user.click(screen.getByRole('button', { name: "Mark selected as attended" }));
    const submit = screen.getByRole('button', { name: "Confirm team attendance" }); await user.dblClick(submit);
    await waitFor(() => expect(calls).toHaveLength(1)); expect(screen.getByText(/Submitted rows are locked/)).toBeInTheDocument();
    await act(async () => gate.resolve(ok({ meeting: meeting(), attendances: [] })));
  });
});

const prepareFull = "Everyone attended · prepare review";
function savedAs(row: AttendanceDto, patch: Partial<AttendanceDto>, log: Partial<AttendanceWorkLogDto> = {}): AttendanceDto {
  const source = posted(row);
  if (!source.workLog) throw new Error('Missing work log');
  return { ...source, ...patch, workLog: { ...source.workLog, ...log } };
}

describe('explicit full-attendance preparation and saved roster summary', () => {
  it('prepares attended drafts only for unconfirmed active roster rows; saved sources and custom drafts stay, and nothing is sent before confirm', async () => {
    const rows = attendance();
    const [r0, r1, r2, r3, r4] = rows; if (!r0 || !r1 || !r2 || !r3 || !r4) throw new Error('Missing fixture');
    rows[0] = posted(r0);
    rows[1] = savedAs(r1, { status: 'partial', minutes: 30 }, { minutes: 30 });
    rows[2] = savedAs(r2, { postingState: 'void' }, { state: 'void' });
    const custom: AttendanceDraft = { base: r3, status: 'absent', minutes: '', basis: 'planned_absence', reason: 'Болел' };
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: rows.slice(0, 5) }) });
    const { user, onSaved } = mount({ rows, initialDrafts: { [r3.id]: custom } });

    const summary = screen.getByRole('region', { name: 'Saved attendance by person' });
    for (const text of ['Attended: 1', 'Partial: 1', 'Absent: 0', 'Unconfirmed: 2', 'Voided: 1']) expect(summary).toHaveTextContent(text);
    expect(within(summary).getAllByRole('listitem')).toHaveLength(5);
    expect(within(summary).queryByText('Участник 6')).not.toBeInTheDocument();
    // Per-person saved values only: no team total (1h + 30m) is derived from the visible rows.
    expect(summary).not.toHaveTextContent('1h 30m');
    expect(screen.queryByRole('region', { name: 'Review team attendance' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: prepareFull }));
    expect(calls).toHaveLength(0);
    const review = screen.getByRole('region', { name: 'Review team attendance' });
    expect(review).toHaveTextContent('Rows to save: 1');
    expect(within(review).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Участник 5: Attended entire meeting · 1h']);
    expect(screen.getByText(/1 person is prepared for review\. Nothing is saved yet\. 1 person with your own unsent changes was left as is/)).toBeInTheDocument();
    for (const person of ['Участник 1', 'Участник 2', 'Участник 3', 'Участник 4']) expect(screen.getByRole('checkbox', { name: person })).not.toBeChecked();
    expect(within(summary).getByText(/Attendance unconfirmed · in review/)).toBeInTheDocument();

    // The custom draft is untouched and reachable only through its own explicit controls.
    await user.click(screen.getByRole('checkbox', { name: 'Участник 4' }));
    expect(screen.getByLabelText('Attendance outcome: Участник 4')).toHaveTextContent(outcomeLabels.absent);
    expect(screen.getByLabelText('Attendance reason: Участник 4')).toHaveValue('Болел');
    await user.click(screen.getByRole('checkbox', { name: 'Участник 4' }));

    await user.click(screen.getByRole('button', { name: 'Confirm team attendance' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ expectedMeetingRevision: 3, periodId: PERIOD_A, rows: [{ attendanceId: r4.id, expectedAttendanceRevision: r4.revision, expectedWorkLogRevision: null, kind: 'confirm', status: 'present', attributionBasis: 'actual_meeting', minutes: 60, reason: null }] });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), [r4.id]));
  });

  it.each([
    { name: 'cancelled', current: meeting({ state: 'cancelled', actualStartAt: null, actualDurationMinutes: null }), help: /A cancelled meeting cannot be prepared as attended/ },
    { name: 'actual details unsaved', current: meeting({ actualStartAt: null, actualDurationMinutes: null }), help: /Save the actual start and duration above/ },
    { name: 'viewer or archived', current: meeting(), writable: false, help: /only for unconfirmed people/ },
    { name: 'another command held', current: meeting(), blocked: true, help: /only for unconfirmed people/ },
  ])('cannot prepare full attendance: $name', async ({ current, writable = true, blocked = false, help }) => {
    const { calls } = installFakeApi({});
    const { user } = mount({ current, writable, blocked });
    const button = screen.getByRole('button', { name: prepareFull });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(screen.getByText(help)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Review team attendance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm team attendance' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('never rebases prepared drafts over a roster refetch and retries a lost confirmation with the exact original body and key', async () => {
    const rows = attendance();
    const [, r1, r2] = rows; if (!r1 || !r2) throw new Error('Missing fixture');
    const gate = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi({ [path]: () => ++attempts === 1 ? gate.promise : ok({ meeting: meeting(), attendances: rows.slice(0, 5) }) });
    const { user, onSaved, refetch } = mount({ rows });
    await user.click(screen.getByRole('button', { name: prepareFull }));
    expect(screen.getByRole('region', { name: 'Review team attendance' })).toHaveTextContent('Rows to save: 5');

    // Someone else saved a partial entry for person 2 and person 3 left the roster.
    refetch(rows.map(row => row.id === r1.id ? { ...savedAs(row, { status: 'partial', minutes: 30 }, { minutes: 30 }), revision: 7 } : row.id === r2.id ? { ...row, rosterActive: false } : row));
    expect(screen.getByRole('region', { name: 'Review team attendance' })).toHaveTextContent('Rows to save: 4');
    expect(within(screen.getByRole('region', { name: 'Saved attendance by person' })).getByText(/Saved: partial attendance · 30m · in review/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: prepareFull })).toBeDisabled();
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Confirm team attendance' }));
    await waitFor(() => expect(attempts).toBe(1));
    const sent = calls[0]?.body as { rows: { attendanceId: string; expectedAttendanceRevision: number }[] };
    expect(sent.rows.map(row => row.attendanceId)).toEqual(rows.filter(row => row.rosterActive && row.id !== r2.id).map(row => row.id));
    // The held snapshot goes to the server unchanged; its guard, not a silent rebase, decides.
    expect(sent.rows.find(row => row.attendanceId === r1.id)?.expectedAttendanceRevision).toBe(r1.revision);
    await act(async () => gate.lose());
    expect(screen.getByRole('button', { name: prepareFull })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry original team attendance' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });
});
