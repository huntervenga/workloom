import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedActivityContributionDto, SharedActivityRecordDto } from '@workloom/contracts';
import { alpha, alphaMembers, anna } from '../../test/fakeApi';
import { task } from '../planning/test/fixtures';
import { SharedActivityPanel } from './SharedActivityPanel';

const mocks = vi.hoisted(() => ({ record: null as unknown, mutate: vi.fn(), configure: vi.fn() }));
vi.mock('./queries', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSharedActivityRecord: () => ({ isSuccess: true, isError: false, isPending: false, isFetching: false, data: mocks.record, refetch: async () => ({ isSuccess: true, data: mocks.record }) }),
}));
vi.mock('../fields/queries', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTaskFieldValuesQuery: () => ({ isSuccess: true, isFetching: false, data: [], refetch: async () => ({ isSuccess: true, data: [] }) }),
}));
vi.mock('../../lib/protectedDrafts', () => ({ useProtectedDraft: () => undefined }));

const id = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const people = alphaMembers.slice(0, 3);
function contribution(n: number, membershipId: string, patch: Partial<SharedActivityContributionDto> = {}): SharedActivityContributionDto {
  return { id: id(n), workspaceId: alpha.id, activityId: id(90), taskId: task.id, membershipId, revision: 1, rosterActive: true, originalPlannedMinutes: 15, currentPlannedMinutes: 15, plannedOverride: false,
    originalActivityRevision: 1, plannedActivityRevision: 1, attendance: 'unconfirmed', postingState: 'unconfirmed', minutes: null, confirmedActivityRevision: null, confirmedFactValueRevision: null,
    confirmedDurationMinutes: null, confirmedOccurrenceDate: null, category: null, reason: null, updatedAt: '2026-10-26T09:00:00.000Z', ...patch };
}
function recordWith(contributions: SharedActivityContributionDto[]): SharedActivityRecordDto {
  return { activity: { id: id(90), workspaceId: alpha.id, projectId: task.projectId, taskId: task.id, revision: 1, planFieldId: id(70), factFieldId: id(71), categoryFieldId: null, organizerMembershipId: people[0]?.id ?? '',
      occurrenceDate: '2026-10-26', startAt: null, recordingUrl: null, summaryUrl: null, summaryText: null, createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-10-26T09:00:00.000Z' },
    contributions, permissions: { selfMembershipId: people[0]?.id ?? '', canWriteSelf: true, canWriteOthers: true, canEditActivity: true },
    plannedDurationMinutes: 15, actualDurationMinutes: 120, planValueRevision: 1, factValueRevision: 1 };
}
const command = (mutate: typeof mocks.mutate) => ({ pendingCommand: null, uncertain: null, variables: null, error: null, mutate, retryUncertain: vi.fn(), hasOtherProtectedCommands: () => false });
function show(contributions: SharedActivityContributionDto[]) {
  mocks.record = recordWith(contributions);
  const controller = { actorId: anna.id, workspaceId: alpha.id, projectId: task.projectId, drafts: {}, setTaskDraft: vi.fn(), configure: command(mocks.configure), attendance: command(mocks.mutate) };
  render(<SharedActivityPanel controller={controller as never} task={task} fields={[]} members={alphaMembers} writable current beforeCommand={async () => task} />);
  return userEvent.setup();
}
async function choose(user: ReturnType<typeof userEvent.setup>, person: string, value: string) {
  await user.click(screen.getByRole('combobox', { name: `Attendance for ${person}` }));
  await user.click(screen.getByRole('option', { name: value }));
}
const rowsSent = () => (mocks.mutate.mock.calls[0]?.[0] as { input: { rows: { contributionId: string; attendance: string; minutes?: number; reason?: string }[] } }).input.rows;

describe('shared call attendance saves as it is chosen', () => {
  beforeEach(() => { mocks.mutate.mockClear(); mocks.configure.mockClear(); });

  it('saves Present at once, with no confirm button', async () => {
    const [first, second] = people;
    const user = show([contribution(1, first?.id ?? ''), contribution(2, second?.id ?? '')]);
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    await choose(user, second?.displayName ?? '', 'Present — full duration');
    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(rowsSent()).toEqual([expect.objectContaining({ contributionId: id(2), attendance: 'present' })]);
  });

  it('marks every unconfirmed person present with one action', async () => {
    const user = show(people.map((person, index) => contribution(index + 1, person.id)));
    await user.click(screen.getByRole('button', { name: 'Everyone present' }));
    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(rowsSent().map(row => row.attendance)).toEqual(['present', 'present', 'present']);
  });

  it('asks for minutes on Partial and saves when the field is left', async () => {
    const [first] = people;
    const user = show([contribution(1, first?.id ?? '')]);
    await choose(user, first?.displayName ?? '', 'Partial');
    expect(mocks.mutate).not.toHaveBeenCalled();
    const minutes = screen.getByRole('spinbutton', { name: 'Personal actual minutes' });
    await user.type(minutes, '30');
    await user.tab();
    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(rowsSent()).toEqual([expect.objectContaining({ contributionId: id(1), attendance: 'partial', minutes: 30 })]);
  });

  it('keeps a correction of saved time waiting for its reason, then saves it', async () => {
    const [first] = people;
    const confirmed = contribution(1, first?.id ?? '', { attendance: 'present', postingState: 'active', minutes: 120, confirmedActivityRevision: 1, confirmedFactValueRevision: 1, confirmedDurationMinutes: 120, confirmedOccurrenceDate: '2026-10-26' });
    const user = show([confirmed]);
    await choose(user, first?.displayName ?? '', 'Absent — zero minutes');
    expect(mocks.mutate).not.toHaveBeenCalled();
    const reason = screen.getByRole('textbox', { name: 'Reason for correcting saved time' });
    await user.type(reason, 'Was on leave{Enter}');
    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(rowsSent()).toEqual([expect.objectContaining({ contributionId: id(1), attendance: 'absent', reason: 'Was on leave' })]);
  });

  it('does not offer the one-click action once everyone is confirmed', () => {
    const [first] = people;
    show([contribution(1, first?.id ?? '', { attendance: 'present', postingState: 'active', minutes: 120, confirmedActivityRevision: 1, confirmedDurationMinutes: 120 })]);
    expect(screen.queryByRole('button', { name: 'Everyone present' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Attendance' })).getByText(/Saved: Present/)).toBeVisible();
  });

  it('saves a change to the call settings by itself, without a save button', async () => {
    const [first, second] = people;
    const user = show([contribution(1, first?.id ?? '')]);
    await user.click(screen.getByText('Call settings'));
    expect(screen.queryByRole('button', { name: 'Save call setup' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Organizer' }));
    await user.click(screen.getByRole('option', { name: second?.displayName ?? '' }));
    await vi.waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(1), { timeout: 4000 });
    const sent = mocks.configure.mock.calls[0]?.[0] as { input: { configuration: { organizerMembershipId: string } } };
    expect(sent.input.configuration.organizerMembershipId).toBe(second?.id);
  });
});
