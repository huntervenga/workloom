import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { created, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { commitment, lostResponse, work } from '../planning/test/fixtures';
import { MEMBER_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, TASK_ID, projection, rootPath, tablePath, tableRoutes, task } from './test/fixtures';

async function close(user: ReturnType<typeof renderApp>['user'], name: string) {
  const dialog = screen.getByRole('dialog', { name });
  const top = within(dialog).getAllByRole('button', { name: "Close" }).find((button) => button.hasAttribute('aria-label'));
  if (!top) throw new Error('Missing close button');
  await user.click(top);
}

describe('quick weekly table entry', () => {
  it('requires explicit week selection and keeps a distinct same-week draft B intact while create A is uncertain', async () => {
    const gate = lostResponse();
    const otherTask = { ...task, id: 'f2000000-0000-4000-8000-000000000002', workPackageId: 'f1000000-0000-4000-8000-000000000002', title: 'Другой рабочий результат' };
    let attempts = 0;
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => ok([task, otherTask]), [`GET ${rootPath}/planning-packages`]: () => ok([work, { ...work, id: otherTask.workPackageId, title: otherTask.title }]), [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_A}/task-time-summary`]: (request) => {
      const result = projection(request.searchParams.get('membershipId') ?? MEMBER_ID);
      const ids = request.searchParams.get('taskIds')?.split(',') ?? [];
      result.tasks = [task, otherTask].filter((item) => ids.includes(item.id)).map((item) => ({ meetingId:null,taskId: item.id, workPackageId: item.workPackageId, currentAllocationMinutes: null, ownManualWork: null, subjectActualMinutes: 0, taskActualMinutes: 0, subjectActiveSourceCount: 0, taskActiveSourceCount: 0, hasOtherSources: false }));
      result.packages = result.tasks.map((item) => ({ workPackageId: item.workPackageId, commitment: null, subjectActualMinutes: 0, totalActualMinutes: 0, subjectActiveSourceCount: 0, totalActiveSourceCount: 0 }));
      return ok(result);
    }, [`POST ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ++attempts === 1 ? gate.promise : created(commitment(180)) });
    const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: task.title });
    expect(screen.getByLabelText("Week for hours")).toHaveValue('');
    expect(calls.some((call) => call.path.endsWith('task-time-summary'))).toBe(false);
    await user.selectOptions(screen.getByLabelText("Week for hours"), PERIOD_A);
    await user.click(await screen.findByRole('button', { name: `Weekly plan: ${otherTask.title}` }));
    let dialog = await screen.findByRole('dialog', { name: "Add to weekly plan" });
    await user.type(within(dialog).getByLabelText("Planned hours"), '2');
    await close(user, "Add to weekly plan");
    await user.click(screen.getByRole('button', { name: `Weekly plan: ${task.title}` }));
    dialog = await screen.findByRole('dialog', { name: "Add to weekly plan" });
    expect(within(dialog).getByRole("region", { name: "Time entry context" })).toHaveTextContent(task.title);
    expect(within(dialog).queryByLabelText("Whole task")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Planned hours"), '3');
    await user.click(within(dialog).getByRole('button', { name: "Save personal plan" }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user, "Add to weekly plan");
    await user.click(screen.getByRole('button', { name: `Weekly plan: ${otherTask.title}` }));
    dialog = await screen.findByRole('dialog', { name: "Add to weekly plan" });
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('2');
    expect(within(dialog).getByRole('button', { name: "Save personal plan" })).toBeDisabled();
    await act(async () => gate.lose());
    expect(within(dialog).queryByRole('button', { name: "Retry original save" })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('2');
    await close(user, "Add to weekly plan");
    await user.click(screen.getByRole('button', { name: "Open original hours save" }));
    dialog = await screen.findByRole('dialog', { name: "Add to weekly plan" });
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('3:00');
    await user.click(within(dialog).getByRole('button', { name: "Retry original save" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: `Weekly plan: ${otherTask.title}` }));
    dialog = await screen.findByRole('dialog', { name: "Add to weekly plan" });
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('2');
    const writes = calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toMatchObject({ workPackageId: PACKAGE_ID, membershipId: MEMBER_ID, plannedMinutes: 180 });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(calls.some((call) => call.path.includes(`/tasks/${TASK_ID}/manual-period-work`))).toBe(false);
  });
});
