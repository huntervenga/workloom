import { useState } from 'react';
import { DialogShell } from '../../shared/DialogShell';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, installFakeApi } from '../../test/fakeApi';
import type { TaskTableCustomColumn } from '../task-table/TaskTable';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { DrawerSubtasks } from './DrawerSubtasks';
import type { InitialTimeContext } from './InitialTaskCells';
import type { LoadedSubtasks } from './TaskDrawer';
import { useTaskCommands } from './useTaskCommands';

const PARENT_ID = 'd1000000-0000-4000-8000-000000000001';
const A_ID = 'd1000000-0000-4000-8000-0000000000a1';
const B_ID = 'd1000000-0000-4000-8000-0000000000b1';
const NEW_ID = 'd1000000-0000-4000-8000-0000000000c1';
const PERIOD_A = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_A = 'b1000000-0000-4000-8000-000000000001';
const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 }];
const parent: TaskDto = { ...task, id: PARENT_ID, title: 'Parent', parentTaskId: null };
const child = (id: string, title: string): TaskDto => ({ ...task, id, title, parentTaskId: PARENT_ID, workPackageId: parent.workPackageId, sectionId: parent.sectionId, revision: 3 });
const longTitle = Array.from({ length: 8 }, (_, index) => `segment ${index + 1} of a very long subtask name`).join(' ');
const movePath = (id: string) => `POST ${rootPath}/tasks/${id}/move`;
const weeklyPlan: TaskTableCustomColumn = { id: 'weekly-plan', label: 'Weekly plan', width: 96, renderCell: () => null };

function lost() {
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Response>((_resolve, fail) => { reject = fail; });
  return { promise, lose: () => reject(new TypeError('Failed to fetch')) };
}

function renderSubtasks(children: readonly TaskDto[], options: { context?: InitialTimeContext; addRequest?: number; drawer?: boolean } = {}) {
  const onAnnounce = vi.fn();
  function Example({ addRequest }: { addRequest?: number | undefined }) {
    const commands = useTaskCommands(anna.id, alpha.id);
    const [open, setOpen] = useState(true);
    const scope: LoadedSubtasks = { parentId: PARENT_ID, tasks: children, partial: false, includesArchived: false };
    const content = <DrawerSubtasks parent={parent} scope={scope} projectId={PROJECT_ID} statuses={statuses} members={alphaMembers} sections={[]} tags={[]}
      commands={commands} writable onOpen={vi.fn()} onMoreDetails={vi.fn()} onCreated={vi.fn()} onAnnounce={onAnnounce}
      extraColumns={options.context ? [weeklyPlan] : undefined} initialTimeContext={options.context ?? null} initialTimeWritable={options.context !== undefined} initialTimeCurrent={options.context !== undefined}
      addRequest={addRequest} />;
    return options.drawer ? <DialogShell title="Parent" description="Synthetic task" variant="drawer" open={open} onOpenChange={setOpen}>{content}</DialogShell> : content;
  }
  const ui = renderFieldUi(<Example addRequest={options.addRequest} />);
  return { ...ui, onAnnounce, rerenderWith: (addRequest: number) => ui.rerender(<QueryClientProvider client={ui.client}><Example addRequest={addRequest} /></QueryClientProvider>) };
}

describe('drawer subtask rows', () => {
  it('shows the stored Urgent priority without relabelling it Low', () => {
    installFakeApi({});
    renderSubtasks([{ ...child(A_ID, 'Urgent child'), priority: 'urgent' }, { ...child(B_ID, 'Low child'), priority: 'low' }]);
    const urgentRow = screen.getByRole('button', { name: 'Urgent child' }).closest('tr') as HTMLTableRowElement;
    const lowRow = screen.getByRole('button', { name: 'Low child' }).closest('tr') as HTMLTableRowElement;
    expect(within(urgentRow).getByText('Urgent')).toBeVisible();
    expect(within(urgentRow).queryByText('Low')).not.toBeInTheDocument();
    expect(within(lowRow).getByText('Low')).toBeVisible();
  });

  it('Escape discards an unsent child before closing the real enclosing drawer', async () => {
    const { calls } = installFakeApi({});
    const ui = renderSubtasks([], { drawer: true });
    await ui.user.click(await screen.findByRole('button', { name: 'New subtask row' }));
    await ui.user.type(screen.getByLabelText('Task name'), 'Discard this child');
    await ui.user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Parent' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'New subtask row' }));
    expect(screen.getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    expect(calls).toHaveLength(0);
  });

  it('keeps saved rows as single-line rows with full accessible titles and open labels', () => {
    installFakeApi({});
    renderSubtasks([child(A_ID, longTitle), child(B_ID, 'Beta child')]);
    const name = screen.getByRole('button', { name: longTitle });
    expect(name).toHaveAttribute('title', longTitle);
    expect(screen.getByRole('button', { name: `Open subtask “${longTitle}” · Stored todo · Detail` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open subtask “Beta child” · Stored todo · Detail' })).toBeInTheDocument();
  });

  it('opens the inline first subtask row without any request until a title is entered, without an anchor', async () => {
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => created({ ...child(NEW_ID, (request.body as { title: string }).title) }) });
    const ui = renderSubtasks([]);
    ui.rerenderWith(1);
    expect(await screen.findByLabelText('Task name')).toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByLabelText('Task name'));
    await ui.user.keyboard('First child{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe(`${rootPath}/tasks`);
    expect(calls[0]?.body).toMatchObject({ parentTaskId: PARENT_ID, workScope: 'detail', title: 'First child' });
    expect(calls[0]?.body).not.toHaveProperty('insertion');
  });

  it('stages a guarded whole parent plan in a new detail row and sends it atomically', async () => {
    const guarded: InitialTimeContext = { periodId: PERIOD_A, membershipId: MEMBER_A, periodName: 'Week 43', memberName: 'Anna Stored', plan: { workPackageId: parent.workPackageId, expectedRevision: 4 } };
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks/rows`]: request => created({ task: child(NEW_ID, (request.body as { task: { title: string } }).task.title), fields: [] }) });
    const ui = renderSubtasks([], { context: guarded });
    await ui.user.click(screen.getByRole('button', { name: 'New subtask row' }));
    await ui.user.type(screen.getByRole('textbox', { name: 'Planned hours for the whole parent package: Week 43, Anna Stored' }), '2');
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByLabelText('Task name'));
    await ui.user.keyboard('Child guarded{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe(`${rootPath}/tasks/rows`);
    expect(calls[0]?.body).toMatchObject({
      task: { parentTaskId: PARENT_ID, workScope: 'detail', title: 'Child guarded' },
      plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: 4, plannedMinutes: 120 },
    });
  });

  it('reorders a subtask among its loaded siblings from the keyboard through the guarded move', async () => {
    const { calls } = installFakeApi({ [movePath(B_ID)]: () => created({ ...child(B_ID, 'Beta child'), revision: 4 }) });
    const ui = renderSubtasks([child(A_ID, 'Alpha child'), child(B_ID, 'Beta child')]);
    act(() => screen.getByRole('button', { name: 'Move task: Beta child' }).focus());
    await ui.user.keyboard('{ArrowUp}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe(`${rootPath}/tasks/${B_ID}/move`);
    expect(calls[0]?.body).toEqual({ expectedRevision: 3, anchorTaskId: A_ID, placement: 'before', captureUndo: true });
  });

  it('refuses another reorder while one is unknown and retries the exact one from visible feedback', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({
      [movePath(B_ID)]: () => ++attempt === 1 ? first.promise : created({ ...child(B_ID, 'Beta child'), revision: 4 }),
      [movePath(A_ID)]: () => created(child(A_ID, 'Alpha child')),
    });
    const ui = renderSubtasks([child(A_ID, 'Alpha child'), child(B_ID, 'Beta child')]);
    act(() => screen.getByRole('button', { name: 'Move task: Beta child' }).focus());
    await ui.user.keyboard('{ArrowUp}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => first.lose());
    const retry = await screen.findByRole('button', { name: 'Retry original' });
    act(() => screen.getByRole('button', { name: 'Move task: Alpha child' }).focus());
    await ui.user.keyboard('{ArrowDown}');
    expect(calls).toHaveLength(1);
    expect(ui.onAnnounce).toHaveBeenCalledWith(expect.objectContaining({ key: 'taskTable.move.wait' }));
    await ui.user.click(retry);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.path).toBe(calls[0]?.path);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(within(document.body).queryByRole('button', { name: 'Retry original' })).not.toBeInTheDocument());
  });
});
