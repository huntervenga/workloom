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
function mount({ current = meeting(), rows = attendance(), writable = true, blocked = false }: { current?: MeetingDto; rows?: AttendanceDto[]; writable?: boolean; blocked?: boolean } = {}) {
  const onSaved = vi.fn();
  function Harness() {
    const [drafts, setDrafts] = useState<Record<string, AttendanceDraft>>({});
    const [selected, setSelected] = useState<string[]>([]);
    const [open, setOpen] = useState(true);
    const commands = useMeetingCommands(anna.id, alpha.id, PROJECT_ID);
    return <><button onClick={() => setOpen(!open)}>Переключить панель</button><button onClick={() => commands.attendance.mutate({ taskId: TASK_ID, input: { expectedMeetingRevision: current.revision, periodId: PERIOD_A, rows: [{ attendanceId: rows[0]?.id ?? '', expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: 'absent', attributionBasis: 'planned_absence' }] } })}>Личная отправка</button>{open ? <MeetingAttendanceBatch meeting={current} periodLabel="Неделя команды" attendance={rows} members={members} drafts={drafts} onChange={setDrafts} selectedIds={selected} onSelectionChange={setSelected} mutation={commands.attendance} writable={writable} blocked={blocked} onSaved={onSaved} /> : null}</>;
  }
  render(<QueryClientProvider client={createQueryClient({ retry: false })}><Harness /></QueryClientProvider>);
  return { user: userEvent.setup(), onSaved };
}
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Подготовить присутствие команды' }));
}

describe('controlled team attendance review and command boundary', () => {
  it('never posts on invitation, opening, or preparation; unknown stays skipped and removed roster is excluded', async () => {
    const { calls } = installFakeApi({});
    const { user } = mount();
    expect(screen.queryByLabelText('Результат команды: Участник 1')).not.toBeInTheDocument();
    await prepare(user);
    expect(screen.getAllByRole('combobox')).toHaveLength(5);
    expect(screen.getByLabelText('Результат команды: Участник 1')).toHaveValue('unknown');
    expect(screen.queryByText('Участник 6')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('reviews 3×60 + partial30 + absent0 and submits all five guarded sources in one actual request', async () => {
    const rows = attendance();
    const current = meeting();
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: current, attendances: rows.slice(0, 5) }) });
    const { user, onSaved } = mount({ rows, current });
    await prepare(user);
    await user.click(screen.getByRole('button', { name: 'Все выбранные присутствовали' }));
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 4'), 'partial');
    await user.type(screen.getByLabelText('Время команды, часы: Участник 4'), '0:30');
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 5'), 'absent');
    const review = screen.getByRole('region', { name: 'Проверка командного присутствия' });
    expect(within(review).getByText(/Подтверждаемые минуты: 3 ч 30 мин/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
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
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'absent');
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(calls[0]?.body).toMatchObject({ rows: [{ attendanceId: rows[0]?.id, status: 'absent' }] });
    expect(onSaved).toHaveBeenCalledWith(response, [rows[0]?.id]);
  });

  it('keeps absence zero distinct from skip and requires saved actual details for positive attendance', async () => {
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) });
    const { user } = mount({ current: meeting({ actualStartAt: null, actualDurationMinutes: null }) });
    await prepare(user);
    expect(screen.getByRole('button', { name: 'Все выбранные присутствовали' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'present');
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled();
    expect(screen.getByText(/Сначала сохраните фактическое начало/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'absent');
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
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
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'partial');
    const minutes = screen.getByLabelText('Время команды, часы: Участник 1');
    await user.clear(minutes); await user.type(minutes, '0:30');
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled();
    await user.type(screen.getByLabelText('Причина команды: Участник 1'), 'Уточнили участие');
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ expectedAttendanceRevision: 4, expectedWorkLogRevision: 9, kind: 'confirm', status: 'partial', minutes: 30, reason: 'Уточнили участие' }] });
    expect(JSON.stringify(calls[0]?.body)).not.toContain('category');
  });

  it('requires reason for void and rejects partial0 or duration overflow without any network write', async () => {
    const rows = attendance(); const first = rows[0]; if (!first) throw new Error('Missing fixture'); rows[0] = posted(first);
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) }); const { user } = mount({ rows }); await prepare(user);
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'void');
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled();
    await user.type(screen.getByLabelText('Причина команды: Участник 1'), 'Ошибка');
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'partial');
    const minutes = screen.getByLabelText('Время команды, часы: Участник 1');
    for (const value of ['0', '1:01']) { await user.clear(minutes); await user.type(minutes, value); expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled(); }
    expect(calls).toHaveLength(0);
    await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'void');
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ kind: 'void', expectedAttendanceRevision: 4, expectedWorkLogRevision: 9, reason: 'Ошибка' }] });
  });

  it('allows truthful cancelled planned absence only with a reason and no invented actual start', async () => {
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) });
    const { user } = mount({ current: meeting({ state: 'cancelled', actualStartAt: null, actualDurationMinutes: null }) });
    await prepare(user); await user.selectOptions(screen.getByLabelText('Результат команды: Участник 1'), 'absent');
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled();
    await user.type(screen.getByLabelText('Причина команды: Участник 1'), 'Встреча отменена');
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ rows: [{ status: 'absent', minutes: 0, attributionBasis: 'planned_absence', reason: 'Встреча отменена' }] });
    expect(JSON.stringify(calls[0]?.body)).not.toContain('actualStartAt');
  });

  it('keeps page-owned batch edits across closing and retries lost responses with exactly the original body/key', async () => {
    const gate = lostResponse(); let attempts = 0;
    const response = { meeting: meeting(), attendances: attendance() };
    const { calls } = installFakeApi({ [path]: () => ++attempts === 1 ? gate.promise : ok(response) });
    const { user, onSaved } = mount(); await prepare(user); await user.click(screen.getByRole('button', { name: 'Все выбранные присутствовали' }));
    await user.click(screen.getByRole('button', { name: 'Переключить панель' }));
    await user.click(screen.getByRole('button', { name: 'Переключить панель' }));
    expect(screen.getByLabelText('Результат команды: Участник 1')).toHaveValue('present');
    await user.click(screen.getByRole('button', { name: 'Подтвердить присутствие команды' }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(screen.getByRole('button', { name: 'Подготовить присутствие команды' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Переключить панель' })); await act(async () => gate.lose());
    await user.click(screen.getByRole('button', { name: 'Переключить панель' }));
    expect(screen.getByText(/Повторяется только исходная отправка/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Результат команды: Участник 1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Повторить командное присутствие' }));
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
    expect(screen.queryByRole('button', { name: 'Повторить командное присутствие' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подготовить присутствие команды' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Подтвердить присутствие команды' })).toBeDisabled();
    expect(calls).toHaveLength(1);
  });

  it.each([{ writable: false }, { blocked: true }])('cannot prepare or send with denied permission/another held command: %j', async props => {
    const { calls } = installFakeApi({}); const { user } = mount(props);
    const prepareButton = screen.getByRole('button', { name: 'Подготовить присутствие команды' });
    expect(prepareButton).toBeDisabled(); await user.click(prepareButton); expect(calls).toHaveLength(0);
  });

  it.each([{ actualStartAt: STAMP, needsReason: false }, { actualStartAt: '2026-10-01T11:00:00.000Z', needsReason: true }])('compares effective occurrence attribution rather than unrelated meeting revisions: %j', async ({ actualStartAt, needsReason }) => {
    const rows = attendance(); const first = rows[0]; if (!first) throw new Error('Missing fixture'); rows[0] = posted(first);
    const { calls } = installFakeApi({ [path]: () => ok({ meeting: meeting(), attendances: [] }) });
    const { user } = mount({ rows, current: meeting({ actualStartAt, recordingUrl: 'https://example.com/recording' }) });
    await prepare(user);
    const submit = screen.getByRole('button', { name: 'Подтвердить присутствие команды' });
    if (needsReason) { expect(submit).toBeDisabled(); await user.type(screen.getByLabelText('Причина команды: Участник 1'), 'Уточнили фактическое начало'); }
    expect(submit).toBeEnabled(); await user.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ expectedMeetingRevision: 3, rows: [{ expectedAttendanceRevision: 4, expectedWorkLogRevision: 9, status: 'present', reason: needsReason ? 'Уточнили фактическое начало' : null }] });
  });

  it('retains the pending immutable snapshot without a second send on repeat clicks', async () => {
    const gate = deferred<Response>(); const { calls } = installFakeApi({ [path]: () => gate.promise });
    const { user } = mount(); await prepare(user); await user.click(screen.getByRole('button', { name: 'Все выбранные присутствовали' }));
    const submit = screen.getByRole('button', { name: 'Подтвердить присутствие команды' }); await user.dblClick(submit);
    await waitFor(() => expect(calls).toHaveLength(1)); expect(screen.getByText(/Отправленные строки закреплены/)).toBeInTheDocument();
    await act(async () => gate.resolve(ok({ meeting: meeting(), attendances: [] })));
  });
});
