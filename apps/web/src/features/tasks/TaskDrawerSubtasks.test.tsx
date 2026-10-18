import type { TaskDto } from '@workloom/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { failure, json, ok, installFakeApi, renderApp, type RouteTable } from '../../test/fakeApi';
import { STAMP, rootPath, task } from '../planning/test/fixtures';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';

beforeAll(async () => { await import('../../routes/ProjectPage'); });
const PARENT = 'f2000000-0000-4000-8000-000000000020';
const id = (n: number) => `f2000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const STATUS = 'Запланировано';
const parent: TaskDto = { ...task, id: PARENT, title: 'Loaded parent task' };
const longTitle = 'A deliberately long subtask title that must stay readable in full inside the drawer without truncation';
// Manual order is position first: the detail (position 0) comes before additional work (position 1).
const additional: TaskDto = { ...task, id: id(21), parentTaskId: PARENT, title: 'Additional child', position: 1, workPackageId: 'f1000000-0000-4000-8000-000000000021' };
const detail: TaskDto = { ...task, id: id(22), parentTaskId: PARENT, title: longTitle, position: 0 };
const grandchild: TaskDto = { ...task, id: id(23), parentTaskId: detail.id, title: 'Grandchild task' };
const unrelated: TaskDto = { ...task, id: id(24), title: 'Unrelated root task' };
const archivedChild: TaskDto = { ...task, id: id(25), parentTaskId: PARENT, title: 'Archived child', position: 2, archivedAt: STAMP };
const page = (rows: TaskDto[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'subtasks', nextCursor } });
function routes(rows: TaskDto[], extra: RouteTable = {}, nextCursor: string | null = null): RouteTable {
  const table: RouteTable = { ...tableRoutes(), [`GET ${rootPath}/tasks`]: request => page(request.searchParams.get('includeArchived') === 'true' ? [...rows, archivedChild] : rows, nextCursor) };
  for (const row of [parent, additional, detail, grandchild, unrelated, archivedChild]) table[`GET ${rootPath}/tasks/${row.id}`] = () => ok(row);
  return { ...table, ...extra };
}
const subtasks = async () => within(await screen.findByRole('region', { name: 'Subtasks' }));
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');

describe('drawer loaded subtasks', () => {
  it('lists only loaded direct children in manual order with full title, status and scope', async () => {
    const { calls } = installFakeApi(routes([additional, parent, grandchild, detail, unrelated]));
    renderApp(`${tablePath}?task=${PARENT}`);
    const list = await subtasks();
    const buttons = await list.findAllByRole('button', { name: /^Open subtask “/ });
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      `Open subtask “${longTitle}” · ${STATUS} · Detail`,
      `Open subtask “${additional.title}” · ${STATUS} · Additional work`,
    ]);
    // The fixed-height row truncates visually but preserves the complete name and tooltip.
    const full = list.getByRole('button', { name: longTitle });
    expect(full).toHaveTextContent(longTitle);
    expect(full).toHaveAttribute('title', longTitle);
    expect(full).toHaveAccessibleName(longTitle);
    expect(full).toHaveClass('truncate');
    expect(full.closest('tr')).toHaveAttribute('data-task-row', detail.id);
    expect(full.closest('tr')).toHaveClass('h-[41px]');
    expect(list.queryByText(grandchild.title)).not.toBeInTheDocument(); expect(list.queryByText(unrelated.title)).not.toBeInTheDocument();
    expect(list.queryByText(/loaded in this view/)).not.toBeInTheDocument();
    // The explicit Detail / Additional work choice stays in the Add subtask flow (its inline row's More details).
    const add = list.getByRole('button', { name: 'Add subtask' });
    expect(add).toBeInTheDocument();
    const section = add.closest('section');
    if (!section) throw new Error('Subtask header action has no section.');
    expect(screen.getByLabelText('Description').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it('opens a child while keeping the parent’s unsaved draft for Back to parent', async () => {
    const { calls } = installFakeApi(routes([parent, detail, additional]));
    const { user } = renderApp(`${tablePath}?task=${PARENT}`);
    const name = await screen.findByLabelText('Task name');
    await user.clear(name); await user.type(name, 'Unsaved parent title');
    await user.click((await subtasks()).getByRole('button', { name: /^Open subtask “Additional child”/ }));
    await screen.findByRole('dialog', { name: additional.title });
    expect(screen.getByLabelText('Task name')).toHaveValue(additional.title);
    await user.click(screen.getByRole('button', { name: 'Open parent' }));
    await waitFor(() => expect(screen.getByLabelText('Task name')).toHaveValue('Unsaved parent title'));
    expect(screen.getByText('Your unsaved draft has been restored.')).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it('labels a subset when more pages exist and never says there are no subtasks', async () => {
    installFakeApi(routes([parent, unrelated], {}, 'more-tasks'));
    renderApp(`${tablePath}?task=${PARENT}`);
    const list = await subtasks();
    expect(list.getByText('Showing only subtasks among the tasks loaded in this view. Filters, search or unloaded pages may hide others.')).toBeInTheDocument();
    expect(list.getByText('No subtasks among the loaded tasks in this view.')).toBeInTheDocument();
    expect(list.queryByText('No subtasks.')).not.toBeInTheDocument();
  });

  it('labels a filtered list as a subset too', async () => {
    installFakeApi(routes([parent, detail]));
    renderApp(`${tablePath}?task=${PARENT}&status=${task.statusId}`);
    const list = await subtasks();
    expect(await list.findByRole('button', { name: /^Open subtask/ })).toBeInTheDocument();
    expect(list.getByText(/Showing only subtasks among the tasks loaded in this view/)).toBeInTheDocument();
  });

  it('follows the archived filter: hidden archived children are named, included ones are marked', async () => {
    installFakeApi(routes([parent]));
    const first = renderApp(`${tablePath}?task=${PARENT}`);
    expect(await (await subtasks()).findByText('No active subtasks. Archived subtasks are hidden.')).toBeInTheDocument();
    first.unmount();
    installFakeApi(routes([parent]));
    renderApp(`${tablePath}?task=${PARENT}&includeArchived=true`);
    const list = await subtasks();
    const archived = await list.findByRole('button', { name: /^Open subtask “Archived child”/ });
    expect(within(archived).getByText('Archived')).toBeInTheDocument();
    expect(list.queryByText(/^No /)).not.toBeInTheDocument();
  });

  it('says plainly when a complete, unfiltered list has no subtasks', async () => {
    installFakeApi(routes([parent, unrelated], { [`GET ${rootPath}/tasks`]: () => page([parent, unrelated]) }));
    renderApp(`${tablePath}?task=${PARENT}&includeArchived=true`);
    const list = await subtasks();
    // Including archived tasks widens the list, so a complete answer is the whole project.
    expect(await list.findByText('No subtasks.')).toBeInTheDocument();
    expect(list.queryByText(/Showing only subtasks/)).not.toBeInTheDocument();
  });

  it('claims nothing about subtasks while the task list itself failed to load', async () => {
    const { calls } = installFakeApi(routes([parent], { [`GET ${rootPath}/tasks`]: () => failure(503, 'SERVICE_UNAVAILABLE', 'list diagnostic') }));
    renderApp(`${tablePath}?task=${PARENT}`);
    await screen.findByRole('dialog', { name: parent.title });
    await waitFor(() => expect(calls.some(call => call.path === `${rootPath}/tasks`)).toBe(true));
    expect(screen.queryByRole('region', { name: 'Subtasks' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No .*subtasks/)).not.toBeInTheDocument();
  });
});
