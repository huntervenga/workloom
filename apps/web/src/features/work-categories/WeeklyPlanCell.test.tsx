import type { PeriodCommitmentDto, TaskTimeSummaryDto } from '@workloom/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, created, installFakeApi, ok, project, renderApp, singleActorRoutes } from '../../test/fakeApi';
import { commitment, work } from '../planning/test/fixtures';
import { chooseTimeContext } from './test/timeContext';
import { MEMBER_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, TASK_ID, projection, rootPath, tablePath, tableRoutes, task } from './test/fixtures';

// Load the lazy route outside the first interaction's DOM wait, as the other project integration suites do.
beforeAll(async () => { await import('../../routes/ProjectPage'); });

// A second loaded task in the same work package: one personal plan covers both rows.
const sibling = { ...task, id: 'f2000000-0000-4000-8000-000000000009', title: 'Вторая часть того же пакета', position: 1 };

function summary(plan: PeriodCommitmentDto | null, allocations: Record<string, number> = {}): TaskTimeSummaryDto {
  const result = projection();
  const base = result.tasks[0];
  if (!base) throw new Error('Missing task fixture');
  result.tasks = [task, sibling].map(item => ({ ...base, taskId: item.id, currentAllocationMinutes: allocations[item.id] ?? null }));
  const pack = result.packages[0];
  if (!pack) throw new Error('Missing package fixture');
  pack.commitment = plan;
  return result;
}

function planCell(title: string) {
  const button = screen.getByRole('button', { name: `Weekly plan: ${title}` });
  const cell = button.parentElement;
  if (!cell) throw new Error('Missing plan cell');
  return { button, cell };
}

async function openTable(plan: PeriodCommitmentDto | null, allocations: Record<string, number> = {}, extra = {}) {
  const api = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => ok([task, sibling]), [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_A}/task-time-summary`]: () => ok(summary(plan, allocations)), ...extra });
  const ui = renderApp(tablePath);
  await chooseTimeContext(ui.user, 'Week for hours', PERIOD_A);
  await screen.findByRole('button', { name: `Weekly plan: ${task.title}` });
  return { ...api, ...ui };
}

describe('weekly plan cell in the task table', () => {
  it('shows an unsplit personal plan once for the package and marks other rows as sharing it', async () => {
    const { calls } = await openTable(commitment(360));
    expect(planCell(task.title).button).toHaveTextContent(/^6h$/);
    expect(planCell(task.title).cell).toHaveTextContent('Whole-package plan, not split by task');
    expect(planCell(task.title).cell).not.toHaveTextContent('Unallocated');
    // The second row never repeats 6h as if it were another 6h to add.
    expect(planCell(sibling.title).button).toHaveTextContent(/^In package$/);
    expect(planCell(sibling.title).cell).toHaveTextContent('Shares one package plan: 6h');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it.each([
    { name: 'no plan', plan: null, first: /^No plan$/, note: null },
    { name: 'unknown plan', plan: { ...commitment(360), plannedMinutes: null, unallocatedMinutes: null }, first: /^Not set$/, note: 'Whole-package plan, not split by task' },
    { name: 'confirmed zero', plan: commitment(0), first: /^0m$/, note: 'Whole-package plan, not split by task' },
    { name: 'removed plan', plan: { ...commitment(360), state: 'removed' as const }, first: /^Removed$/, note: 'Removed from current plan · previously: 6h' },
    { name: 'baseline-pinned added plan', plan: { ...commitment(360), baselineIds: ['f4000000-0000-4000-8000-000000000001'], classification: 'added' as const }, first: /^6h$/, note: 'Whole-package plan, not split by task · baseline saved · added after baseline' },
  ])('keeps $name distinct from zero and from other states', async ({ plan, first, note }) => {
    await openTable(plan);
    expect(planCell(task.title).button).toHaveTextContent(first);
    if (note) expect(planCell(task.title).cell).toHaveTextContent(note);
    else expect(planCell(task.title).cell.querySelector('p')).toBeNull();
  });

  it('shows explicit allocations per task and the remaining personal plan only on the package row', async () => {
    await openTable({ ...commitment(360), allocations: [{ taskId: TASK_ID, minutes: 120 }], unallocatedMinutes: 240 }, { [TASK_ID]: 120 });
    expect(planCell(task.title).button).toHaveTextContent(/^2h$/);
    expect(planCell(task.title).cell).toHaveTextContent('Total personal plan: 6h');
    expect(planCell(task.title).cell).toHaveTextContent('Unallocated: 4h');
    expect(planCell(sibling.title).button).toHaveTextContent(/^Not allocated$/);
    expect(planCell(sibling.title).cell.querySelector('p')).toBeNull();
  });
});

describe('use shared estimate in the personal plan dialog', () => {
  it('fills only the draft and sends the exact explicit create when saved', async () => {
    const { calls, user } = await openTable(null, {}, { [`POST ${rootPath}/periods/${PERIOD_A}/commitments`]: () => created(commitment(1200)) });
    await user.click(planCell(task.title).button);
    const dialog = await screen.findByRole('dialog', { name: 'Add to weekly plan' });
    expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Use shared estimate (20h)' }));
    expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('20:00');
    expect(within(dialog).getByText('Fills this draft only. Nothing is saved until you save the personal plan.')).toBeVisible();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Save personal plan' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toHaveLength(1));
    const write = calls.find(call => call.method === 'POST');
    expect(write?.body).toEqual({ workPackageId: PACKAGE_ID, membershipId: MEMBER_ID, expectedAbsent: true, plannedMinutes: 1200, allocations: [] });
    expect(write?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('says the shared estimate is unknown instead of offering zero', async () => {
    const { calls, user } = await openTable(null, {}, { [`GET ${rootPath}/planning-packages`]: () => ok([{ ...work, estimateMinutes: null }]) });
    await user.click(planCell(task.title).button);
    const dialog = await screen.findByRole('dialog', { name: 'Add to weekly plan' });
    expect(within(dialog).getByText('The shared task estimate is not set.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: /Use shared estimate/ })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it.each([
    { name: 'viewer', extra: { ...singleActorRoutes(anna, [{ ...alpha, role: 'viewer' }], { [alpha.id]: alphaMembers }) } },
    { name: 'archived project', extra: { [`GET ${rootPath}/projects/${PROJECT_ID}`]: () => ok({ ...project(alpha.id, PROJECT_ID, 'Недельный пилот'), archivedAt: '2026-10-19T09:00:00.000Z' }) } },
  ])('offers no estimate fill or save to a $name', async ({ extra }) => {
    const { calls, user } = await openTable(commitment(360), {}, extra);
    await user.click(planCell(task.title).button);
    const dialog = await screen.findByRole('dialog', { name: 'Personal weekly plan' });
    expect(within(dialog).queryByRole('button', { name: /Use shared estimate/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save personal plan' })).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
