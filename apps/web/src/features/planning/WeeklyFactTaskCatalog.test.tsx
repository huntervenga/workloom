import { act, screen, waitFor, within } from '@testing-library/react';
import type { TaskDto } from '@workloom/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, json, ok, renderApp, type FakeRequest } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, TASK_ID, commitment, log, rootPath, routes, task, weekPath, work } from './test/fixtures';

beforeAll(async () => { await import('../../routes/WeeklyPage'); });

const SECOND_TASK_ID = 'f2000000-0000-4000-8000-000000000002';
const SECOND_PACKAGE_ID = 'f1000000-0000-4000-8000-000000000002';
const NEXT_CURSOR = 'opaque-weekly-task-page-2';
const second: TaskDto = { ...task, id: SECOND_TASK_ID, workPackageId: SECOND_PACKAGE_ID, title: 'Второй загруженный сценарий', position: 1 };
const factPath = (taskId: string) => `${rootPath}/tasks/${taskId}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`;
const unavailable = () => failure(503, 'UNAVAILABLE', 'Task catalog unavailable');
const puts = (calls: FakeRequest[]) => calls.filter(call => call.method === 'PUT');

async function openNewFact(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Record actual hours' }));
  return screen.findByRole('dialog', { name: 'Record weekly actual hours' });
}

/** A held reload may relabel or keep its retry control, but never offers an enabled second retry. */
function expectNoEnabledRetry(dialog: HTMLElement, name: string) {
  expect(within(dialog).queryAllByRole('button', { name }).filter(button => !button.matches(':disabled'))).toHaveLength(0);
}

describe('weekly fact task catalog recovery', () => {
  it('keeps a new fact draft through an initial task-catalog failure and saves once after an explicit retry', async () => {
    const initial = deferred<Response>();
    const retry = deferred<Response>();
    let taskReads = 0;
    const { calls } = installFakeApi({
      ...routes(),
      [`GET ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ok([commitment()]),
      [`GET ${rootPath}/tasks`]: () => { taskReads += 1; return taskReads === 1 ? initial.promise : taskReads === 2 ? retry.promise : ok([task]); },
      [`PUT ${factPath(TASK_ID)}`]: () => ok(log(90)),
    });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    const dialog = await openNewFact(user);
    // Pending gate: the dialog opened while the one controlled catalog read is still unanswered.
    expect(taskReads).toBe(1);
    await user.type(within(dialog).getByLabelText('Actual hours this week'), '1:30');
    await act(async () => initial.resolve(unavailable()));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Could not load tasks/i);
    expect(within(dialog).getByRole('button', { name: 'Retry loading tasks' })).toBeEnabled();
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('1:30');
    await user.type(within(dialog).getByLabelText('Comment (optional)'), 'Разбор логов');
    expect(within(dialog).getByLabelText('Comment (optional)')).toHaveValue('Разбор логов');
    expect(within(dialog).getByRole('button', { name: 'Save actual hours' })).toBeDisabled();
    // The task catalog is local to this editor: the loaded week and its saved plans stay in place.
    expect(screen.queryByRole('heading', { name: 'Unable to load week', hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Personal plans', hidden: true })).toHaveTextContent(work.title);

    await user.click(within(dialog).getByRole('button', { name: 'Retry loading tasks' }));
    await waitFor(() => expect(taskReads).toBe(2));
    expect((await within(dialog).findAllByText(/Loading tasks/i)).length).toBeGreaterThan(0);
    expectNoEnabledRetry(dialog, 'Retry loading tasks');
    expect(within(dialog).getByLabelText('Task')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save actual hours' })).toBeDisabled();
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('1:30');
    expect(within(dialog).getByLabelText('Comment (optional)')).toHaveValue('Разбор логов');
    const context = within(dialog).getByRole('region', { name: 'Time entry context' });
    expect(context).toHaveTextContent(anna.displayName);
    expect(context).toHaveTextContent('Неделя А');
    expect(puts(calls)).toHaveLength(0);

    await act(async () => retry.resolve(ok([task])));
    const picker = within(dialog).getByLabelText('Task');
    expect(await within(picker).findByRole('option', { name: task.title })).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Record weekly actual hours' })).toBe(dialog);
    await user.selectOptions(picker, TASK_ID);
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('1:30');
    expect(within(dialog).getByLabelText('Comment (optional)')).toHaveValue('Разбор логов');
    expect(puts(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Save actual hours' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]?.path).toBe(factPath(TASK_ID));
    expect(puts(calls)[0]?.body).toEqual({ expectedRevision: null, minutes: 90, state: 'active', reason: 'Разбор логов' });
  });

  it('keeps loaded options and the typed draft when the next task page fails, then saves a task from the retried page', async () => {
    const retry = deferred<Response>();
    let nextReads = 0;
    const { calls } = installFakeApi({
      ...routes(),
      [`GET ${rootPath}/tasks`]: (request) => {
        if (request.searchParams.get('cursor') === null) return json(200, { data: [task], meta: { requestId: 'req_tasks_first', nextCursor: NEXT_CURSOR } });
        nextReads += 1;
        return nextReads === 1 ? unavailable() : nextReads === 2 ? retry.promise : json(200, { data: [second], meta: { requestId: 'req_tasks_next', nextCursor: null } });
      },
      [`PUT ${factPath(SECOND_TASK_ID)}`]: () => ok({ ...log(120), taskId: SECOND_TASK_ID, workPackageId: SECOND_PACKAGE_ID }),
    });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    const dialog = await openNewFact(user);
    const picker = within(dialog).getByLabelText('Task');
    await within(picker).findByRole('option', { name: task.title });
    await user.selectOptions(picker, TASK_ID);
    await user.type(within(dialog).getByLabelText('Actual hours this week'), '2');
    await user.type(within(dialog).getByLabelText('Comment (optional)'), 'Сверка выгрузки');

    await user.click(within(dialog).getByRole('button', { name: 'Load more tasks' }));
    await waitFor(() => expect(nextReads).toBe(1));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Could not load more tasks/i);
    expect(within(dialog).getByRole('button', { name: 'Retry loading more tasks' })).toBeEnabled();
    expect(within(picker).getByRole('option', { name: task.title })).toBeInTheDocument();
    expect(picker).toHaveDisplayValue(task.title);
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('2');
    expect(within(dialog).getByLabelText('Comment (optional)')).toHaveValue('Сверка выгрузки');
    expect(screen.queryByRole('heading', { name: 'Unable to load week', hidden: true })).not.toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Retry loading more tasks' }));
    await waitFor(() => expect(nextReads).toBe(2));
    expect((await within(dialog).findAllByText(/Loading more tasks/i)).length).toBeGreaterThan(0);
    expectNoEnabledRetry(dialog, 'Retry loading more tasks');
    expect(within(picker).getByRole('option', { name: task.title })).toBeInTheDocument();
    expect(picker).toHaveDisplayValue(task.title);
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('2');
    expect(within(dialog).getByLabelText('Comment (optional)')).toHaveValue('Сверка выгрузки');
    expect(puts(calls)).toHaveLength(0);

    await act(async () => retry.resolve(json(200, { data: [second], meta: { requestId: 'req_tasks_next', nextCursor: null } })));
    expect(await within(picker).findByRole('option', { name: second.title })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: task.title })).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.selectOptions(picker, SECOND_TASK_ID);
    expect(puts(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Save actual hours' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const nextPageReads = calls.filter(call => call.method === 'GET' && call.path === `${rootPath}/tasks` && call.searchParams.get('cursor') !== null);
    expect(nextPageReads.map(call => call.searchParams.get('cursor'))).toEqual([NEXT_CURSOR, NEXT_CURSOR]);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]?.path).toBe(factPath(SECOND_TASK_ID));
    expect(puts(calls)[0]?.body).toEqual({ expectedRevision: null, minutes: 120, state: 'active', reason: 'Сверка выгрузки' });
  });

  it('keeps known task options and the selection when a background task refetch fails', async () => {
    let taskReads = 0;
    const { calls } = installFakeApi({
      ...routes(),
      [`GET ${rootPath}/tasks`]: () => ++taskReads === 2 ? unavailable() : ok([task]),
      [`PUT ${factPath(TASK_ID)}`]: () => ok(log(180)),
    });
    const { user, queryClient } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    const dialog = await openNewFact(user);
    const picker = within(dialog).getByLabelText('Task');
    await within(picker).findByRole('option', { name: task.title });
    await user.selectOptions(picker, TASK_ID);
    await user.type(within(dialog).getByLabelText('Actual hours this week'), '3');

    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskLists(anna.id, alpha.id, PROJECT_ID) }); });
    await waitFor(() => expect(taskReads).toBe(2));
    expect(within(picker).getByRole('option', { name: task.title })).toBeInTheDocument();
    expect(picker).toHaveDisplayValue(task.title);
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('3');
    expect(screen.queryByRole('heading', { name: 'Unable to load week', hidden: true })).not.toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Save actual hours' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]?.body).toEqual({ expectedRevision: null, minutes: 180, state: 'active', reason: null });
  });
});
