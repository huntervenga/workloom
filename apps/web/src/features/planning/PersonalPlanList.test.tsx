import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PeriodCommitmentDto } from '@workloom/contracts';
import { alphaMembers, anna, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { PersonalPlanList } from './PersonalPlanList';
import { BASELINE_ID, MEMBER_ID, PACKAGE_ID, PERIOD_A, commitment, rootPath, routes, task, weekPath, work } from './test/fixtures';

const colleague = alphaMembers[1];
if (!colleague) throw new Error('Missing colleague fixture');
const otherId = colleague.id;
const otherName = colleague.displayName;
const planAt = (index: number, overrides: Partial<PeriodCommitmentDto> = {}): PeriodCommitmentDto => ({ ...commitment(180), id: `f3000000-0000-4000-8000-${String(index).padStart(12, '0')}`, workPackageId: `f1000000-0000-4000-8000-${String(index).padStart(12, '0')}`, ...overrides });
const mixedPlans = [
  planAt(1, { plannedMinutes: null, unallocatedMinutes: null }),
  planAt(2, { membershipId: otherId, plannedMinutes: 0, unallocatedMinutes: 0 }),
  planAt(3, { unallocatedMinutes: 60 }),
  planAt(4, { state: 'removed' }),
  planAt(5, { membershipId: otherId, classification: 'added' }),
  planAt(6, { baselineIds: [BASELINE_ID] }),
];
function renderPlans(overrides: Partial<ComponentProps<typeof PersonalPlanList>> = {}) {
  const props: ComponentProps<typeof PersonalPlanList> = { commitments: mixedPlans, packages: mixedPlans.map((plan, index) => ({ ...work, id: plan.workPackageId, title: `Work ${index + 1}` })), members: alphaMembers, canWrite: true, canManage: true, ownMembershipId: MEMBER_ID, onOpen: vi.fn(), ...overrides };
  const user = userEvent.setup();
  render(<PersonalPlanList {...props} />);
  const table = screen.getByRole('table', { name: 'Personal plans' });
  const rows = within(table).getAllByRole('row').slice(1);
  return { props, user, table, rows };
}

describe('compact personal plans', () => {
  it('keeps unknown and zero values distinct with explicit state labels and contextual keyboard actions', async () => {
    const { props, user, rows } = renderPlans();
    const unknown = rows[0]; const zero = rows[1]; const known = rows[2]; const removed = rows[3]; const added = rows[4]; const pinned = rows[5];
    if (!unknown || !zero || !known || !removed || !added || !pinned) throw new Error('Missing row');
    for (const row of rows) {
      expect([...row.children].map(cell => cell.getAttribute('role'))).toEqual(['rowheader', 'cell', 'cell', 'cell']);
      expect(within(row).getAllByRole('cell')).toHaveLength(3);
    }
    expect(within(unknown).getByText('Not set')).toBeInTheDocument();
    expect(within(unknown).getByText('unknown')).toBeInTheDocument();
    expect(within(zero).getAllByText('0m')).toHaveLength(2);
    expect(within(zero).queryByText('Not set')).not.toBeInTheDocument();
    expect(within(known).getByText('3h')).toBeInTheDocument();
    expect(within(known).getByText('1h')).toBeInTheDocument();
    expect(within(removed).getByText('Removed from current plan')).toBeInTheDocument();
    expect(within(added).getByText('Added after baseline')).toBeInTheDocument();
    expect(within(pinned).getByText('Baseline saved')).toBeInTheDocument();
    const action = within(unknown).getByRole('button', { name: 'Edit plan' });
    expect(action).toHaveAccessibleDescription(`Work 1 ${anna.displayName}`);
    await user.tab();
    expect(action).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onOpen).mock.calls[0]?.[0]).toBe(mixedPlans[0]);
  });

  it.each([
    { name: 'owner', canWrite: true, canManage: true, labels: ['Edit plan', 'Edit plan', 'View plan'] },
    { name: 'member', canWrite: true, canManage: false, labels: ['Edit plan', 'View plan', 'View plan'] },
    { name: 'viewer', canWrite: false, canManage: false, labels: ['View plan', 'View plan', 'View plan'] },
    { name: 'archived project', canWrite: false, canManage: true, labels: ['View plan', 'View plan', 'View plan'] },
  ])('retains edit/view permissions and the exact target for $name', async ({ canWrite, canManage, labels }) => {
    const own = planAt(1); const other = planAt(2, { membershipId: otherId }); const pinned = planAt(3, { baselineIds: [BASELINE_ID], classification: 'added', state: 'removed' });
    const plans = [own, other, pinned];
    const { props, user, rows } = renderPlans({ commitments: plans, canWrite, canManage });
    expect(rows.map(row => within(row).getByRole('button').textContent)).toEqual(labels);
    const target = rows[1]; if (!target) throw new Error('Missing target');
    await user.click(within(target).getByRole('button'));
    expect(vi.mocked(props.onOpen).mock.calls[0]?.[0]).toBe(other);
    const pinnedRow = rows[2]; if (!pinnedRow) throw new Error('Missing pinned row');
    expect(within(pinnedRow).getByText('Removed from current plan')).toBeInTheDocument();
    expect(within(pinnedRow).getByText('Added after baseline')).toBeInTheDocument();
    expect(within(pinnedRow).getByText('Baseline saved')).toBeInTheDocument();
  });

  it('keeps every one of sixteen entries in server order with one action per row', () => {
    const plans = Array.from({ length: 16 }, (_, index) => planAt(index + 1));
    const { table, rows } = renderPlans({ commitments: plans, packages: plans.map((plan, index) => ({ ...work, id: plan.workPackageId, title: `Plan work ${index + 1}` })) });
    expect(rows).toHaveLength(16);
    expect(within(table).getAllByRole('button')).toHaveLength(16);
    expect(rows.map(row => within(row).getByRole('rowheader').textContent)).toEqual(plans.map((_plan, index) => `Plan work ${index + 1}${anna.displayName}`));
  });

  it('uses safe missing-lookup labels and does not substitute another task or person', () => {
    const { rows } = renderPlans({ commitments: [planAt(1)], packages: [], members: [] });
    const row = rows[0]; if (!row) throw new Error('Missing row');
    expect(within(row).getByRole('rowheader')).toHaveTextContent('Saved work');
    expect(within(row).getByRole('rowheader')).toHaveTextContent('Saved person');
    expect(row).not.toHaveTextContent(PACKAGE_ID);
    expect(row).not.toHaveTextContent(MEMBER_ID);
  });

  it('opens the exact other-person entry and pinned view without changing the page person or sending a write', async () => {
    const other = planAt(2, { membershipId: otherId, plannedMinutes: 90, unallocatedMinutes: 90, revision: 4 });
    const pinned = planAt(1, { baselineIds: [BASELINE_ID] });
    const otherWork = { ...work, id: other.workPackageId, title: 'Other person work' };
    const otherTask = { ...task, id: 'f2000000-0000-4000-8000-000000000002', workPackageId: other.workPackageId, title: otherWork.title };
    const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/planning-packages`]: () => ok([work, otherWork]), [`GET ${rootPath}/tasks`]: () => ok([task, otherTask]), [`GET ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ok([pinned, other]) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&worker=${MEMBER_ID}`);
    const table = await screen.findByRole('table', { name: 'Personal plans' });
    const target = within(table).getAllByRole('row').find(row => row.textContent?.includes(otherWork.title));
    if (!target) throw new Error('Missing other-person plan');
    await user.click(within(target).getByRole('button', { name: 'Edit plan' }));
    let dialog = await screen.findByRole('dialog', { name: 'Personal weekly plan' });
    expect(within(dialog).getByRole('region', { name: 'Time entry context' })).toHaveTextContent(otherName);
    expect(within(dialog).getByLabelText('Whole task')).toHaveValue(other.workPackageId);
    expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('1:30');
    expect(screen.getByLabelText('Time entry for')).toHaveValue(MEMBER_ID);
    const close = within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.hasAttribute('aria-label'));
    if (!close) throw new Error('Missing close button');
    await user.click(close);
    await user.click(within(table).getByRole('button', { name: 'View plan' }));
    dialog = await screen.findByRole('dialog', { name: 'Personal weekly plan' });
    expect(within(dialog).getByRole('region', { name: 'Time entry context' })).toHaveTextContent(anna.displayName);
    expect(within(dialog).getByLabelText('Whole task')).toHaveValue(PACKAGE_ID);
    expect(within(dialog).getByLabelText('Planned hours')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save personal plan' })).toBeDisabled();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
