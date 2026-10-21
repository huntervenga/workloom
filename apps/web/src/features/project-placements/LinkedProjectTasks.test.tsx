import { MemoryRouter } from 'react-router';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { field, renderFieldUi, STAMP } from '../fields/test/fixtures';
import type { TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTableExpansionState, tableExpansionStorageKey, type TableExpansionControls } from '../task-table/useTableExpansionState';
import { emptyTaskFilters } from '../tasks/TaskFilters';
import { useTaskCommands } from '../tasks/useTaskCommands';
import { LinkedProjectTasks } from './LinkedProjectTasks';
import { usePlacementCommands } from './queries';
import { homeDone, homeStatus, placement, row, target, targetSection, task } from './testFixtures';
const root = `/api/v1/workspaces/${task.workspaceId}`;
const cleanups: (() => void)[] = [];
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); localStorage.clear(); });
function Harness({ view = 'table', onOpen = () => undefined, expansion, customFields }: { view?: 'table' | 'board' | 'timeline'; onOpen?: (id: string) => void; expansion?: TableExpansionControls; customFields?: readonly { field: TaskFieldDefinitionDto; width: number }[] }) {
  const commands = useTaskCommands(anna.id, task.workspaceId, true);
  const placementCommands = usePlacementCommands(anna.id, task.workspaceId);
  return <LinkedProjectTasks {...(expansion ? { expansion } : {})} {...(customFields ? { customFields } : {})} actorId={anna.id} project={target} sections={[targetSection]} members={alphaMembers} filters={emptyTaskFilters} writable commands={commands} placementCommands={placementCommands} view={view} onOpenTask={onOpen} windowStart="2026-10-19" windowSize={28} sortByDue={false} />;
}
describe('linked table, Board and Timeline adapters', () => {
  it('starts linked children collapsed and restores parent/section choices after remount without domain writes', async () => {
    const childId = 'f2000000-0000-4000-8000-000000000099';
    const childRow = { ...row, placement: { ...placement, id: 'e1000000-0000-4000-8000-000000000099', taskId: childId, position: 41 },
      canonicalTask: { ...task, id: childId, title: 'Linked nested child', parentTaskId: task.id } };
    const rootRow = { ...row, placement: { ...placement, sectionId: targetSection.id } };
    const api = installFakeApi({ [`GET ${root}/projects/${target.id}/rows`]: () => ok([rootRow, childRow]) });
    const renderLinked = () => renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Harness /></MemoryRouter>);
    const ui = renderLinked();
    await screen.findByRole('button', { name: task.title });
    expect(screen.queryByRole('button', { name: 'Linked nested child' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: `Expand subtasks of “${task.title}”` }));
    expect(screen.getByRole('button', { name: 'Linked nested child' })).toBeVisible();
    await ui.user.click(screen.getByRole('button', { name: 'Collapse section “Target section”' }));
    ui.unmount(); ui.client.clear();
    const restored = renderLinked(); cleanups.push(() => { restored.unmount(); restored.client.clear(); });
    await restored.user.click(await screen.findByRole('button', { name: 'Expand section “Target section”' }));
    expect(screen.getByRole('button', { name: 'Linked nested child' })).toBeVisible();
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('uses the shared page controller so native and linked expansion choices cannot overwrite each other', async () => {
    const nativeId = 'f2000000-0000-4000-8000-000000000088', childId = 'f2000000-0000-4000-8000-000000000099';
    const childRow = { ...row, placement: { ...placement, id: 'e1000000-0000-4000-8000-000000000099', taskId: childId, position: 41 }, canonicalTask: { ...task, id: childId, title: 'Shared linked child', parentTaskId: task.id } };
    function SharedPage() {
      const state = useTableExpansionState({ actorId: anna.id, workspaceId: task.workspaceId, projectId: target.id }, [nativeId]);
      return <><button onClick={() => state.setTaskCollapsed(nativeId, false)}>Expand native task</button><Harness expansion={state} /></>;
    }
    installFakeApi({ [`GET ${root}/projects/${target.id}/rows`]: () => ok([row, childRow]) });
    const ui = renderFieldUi(<MemoryRouter><SharedPage /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await ui.user.click(screen.getByRole('button', { name: 'Expand native task' }));
    await ui.user.click(await screen.findByRole('button', { name: `Expand subtasks of “${task.title}”` }));
    expect(screen.getByRole('button', { name: 'Shared linked child' })).toBeVisible();
    const stored = JSON.parse(localStorage.getItem(tableExpansionStorageKey({ actorId: anna.id, workspaceId: task.workspaceId, projectId: target.id })) ?? '{}') as { expandedTaskIds: string[] };
    expect(stored.expandedTaskIds).toEqual([nativeId, task.id]);
  });
  it('shows target-project ordinary fields for linked tasks, preserving zero and missing values', async () => {
    const estimate = { ...field('Hours Est', 'duration'), projectId: target.id };
    const fact = { ...field('Hours Fact', 'duration', '90000000-0000-4000-8000-000000000002'), projectId: target.id };
    const api = installFakeApi({ [`GET ${root}/projects/${target.id}/rows`]: () => ok([row]),
      [`GET ${root}/projects/${target.id}/field-values`]: () => ok([{ workspaceId: task.workspaceId, projectId: target.id, taskId: task.id, fieldId: estimate.id, definitionVersionId: estimate.definitionVersionId, revision: 1, value: { type: 'duration', value: 0 }, updatedAt: STAMP }]) });
    const ui = renderFieldUi(<MemoryRouter><Harness customFields={[{ field: estimate, width: 160 }, { field: fact, width: 160 }]} /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await screen.findByRole('columnheader', { name: 'Hours Est' });
    const taskRow = (await screen.findByRole('button', { name: task.title })).closest('tr');
    if (!taskRow) throw new Error('Missing linked task row');
    await waitFor(() => expect(within(taskRow).getAllByRole('cell')[5]).toHaveTextContent('0m'));
    expect(within(taskRow).getAllByRole('cell')[6]).toHaveTextContent('Not set');
    const reads = api.calls.filter(call => call.path.endsWith('/field-values'));
    expect(reads).toHaveLength(1); expect(reads[0]?.path).toBe(`${root}/projects/${target.id}/field-values`);
    expect(reads[0]?.searchParams.get('taskIds')).toBe(task.id);
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('edits the target placement section without sending a canonical task move or accounting write', async () => {
    const api = installFakeApi({ [`GET ${root}/projects/${target.id}/rows`]: () => ok([row]), [`PATCH ${root}/task-project-placements/${placement.id}`]: () => ok({ ...placement, sectionId: targetSection.id, revision: 8 }) });
    const ui = renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Harness /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    const picker = await screen.findByRole('combobox', { name: 'Section in this project' });
    await waitFor(() => expect(picker).toBeEnabled());
    expect(screen.getByRole('link', { name: 'Canonical home' })).toHaveAttribute('href', `/app/w/${task.workspaceId}/projects/${task.projectId}?task=${task.id}`);
    await ui.user.click(picker);
    await ui.user.click(screen.getByRole('option', { name: 'Target section' }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    await waitFor(() => expect(api.calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(api.calls.find(call => call.method === 'PATCH')?.path).toBe(`${root}/task-project-placements/${placement.id}`);
    expect(api.calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 7, sectionId: targetSection.id });
    expect(api.calls.some(call => call.method !== 'GET' && call.path.includes(`/tasks/${task.id}`))).toBe(false);
  });
  it('keeps long task and home actions accessible while section and removal keep their own revisions', async () => {
    const title = 'A complete canonical task title that should remain accessible when the visible row truncates';
    const homeName = 'The complete canonical home project name remains available from its link';
    const longRow = { ...row, canonicalTask: { ...task, title }, homeProject: { ...row.homeProject, name: homeName } };
    let currentPlacement = placement, detached = false;
    const api = installFakeApi({
      [`GET ${root}/projects/${target.id}/rows`]: () => ok(detached ? [] : [{ ...longRow, placement: currentPlacement }]),
      [`PATCH ${root}/task-project-placements/${placement.id}`]: () => { currentPlacement = { ...currentPlacement, sectionId: targetSection.id, revision: 8 }; return ok(currentPlacement); },
      [`POST ${root}/task-project-placements/${placement.id}/detach`]: () => { detached = true; return ok({ ...currentPlacement, archivedAt: task.createdAt, revision: 9 }); },
    });
    const open = vi.fn();
    const ui = renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Harness onOpen={open} /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await ui.user.click(await screen.findByRole('button', { name: title }));
    expect(open).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(screen.getByRole('link', { name: homeName })).toHaveAttribute('href', `/app/w/${task.workspaceId}/projects/${task.projectId}?task=${task.id}`);
    expect(screen.queryByRole('button', { name: 'Fields and hours in home project' })).not.toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Section in this project' });
    await waitFor(() => expect(picker).toBeEnabled()); await ui.user.click(picker);
    await ui.user.click(screen.getByRole('option', { name: 'Target section' }));
    await waitFor(() => expect(api.calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove from Viewed project' })).toBeEnabled());
    await ui.user.click(screen.getByRole('button', { name: 'Remove from Viewed project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: title })).not.toBeInTheDocument());
    expect(api.calls.filter(call => call.method !== 'GET').map(call => ({ method: call.method, path: call.path, body: call.body }))).toEqual([
      { method: 'PATCH', path: `${root}/task-project-placements/${placement.id}`, body: { expectedRevision: 7, sectionId: targetSection.id } },
      { method: 'POST', path: `${root}/task-project-placements/${placement.id}/detach`, body: { expectedRevision: 8 } },
    ]);
  });
  it('uses actual home status lanes for a linked Board family', async () => {
    const api = installFakeApi({ [`GET ${root}/projects/${target.id}/rows`]: () => ok([row]), [`GET ${root}/projects/${task.projectId}/statuses`]: () => ok([homeStatus, homeDone]) });
    const ui = renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Harness view="board" /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await screen.findByRole('heading', { name: 'Home todo' });
    expect(screen.getByRole('heading', { name: 'Home done' })).toBeInTheDocument();
    expect(document.querySelector(`[data-board-status="${homeDone.id}"]`)).toBeInTheDocument();
    expect(api.calls.some(call => call.path === `${root}/projects/${target.id}/statuses`)).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Viewed todo' })).not.toBeInTheDocument();
  });
  it('drags a linked card through the canonical task writer using a home status ID', async () => {
    const api = installFakeApi({
      [`GET ${root}/projects/${target.id}/rows`]: () => ok([row]),
      [`GET ${root}/projects/${task.projectId}/statuses`]: () => ok([homeStatus, homeDone]),
      [`PATCH ${root}/tasks/${task.id}`]: () => ok({ ...task, statusId: homeDone.id, revision: task.revision + 1 }),
    });
    const ui = renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Harness view="board" /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    const handle = await screen.findByRole('button', { name: `Drag task: ${task.title}` });
    const destination = document.querySelector<HTMLElement>(`[data-board-status="${homeDone.id}"]`);
    if (!destination) throw new Error('Missing home done lane');
    await ui.user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 10, clientY: 10 } });
    await ui.user.pointer({ target: destination, coords: { clientX: 100, clientY: 40 } });
    await ui.user.pointer({ keys: '[/MouseLeft]', target: destination, coords: { clientX: 100, clientY: 40 } });
    await waitFor(() => expect(api.calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(api.calls.find(call => call.method === 'PATCH')?.path).toBe(`${root}/tasks/${task.id}`);
    expect(api.calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: task.revision, statusId: homeDone.id });
  });
  it('opens canonical details from linked Timeline bars and never requests target plans or duplicate hours', async () => {
    const dated = { ...row, canonicalTask: { ...task, startDate: '2026-10-19', dueDate: '2026-10-22' } };
    const api = installFakeApi({ [`GET ${root}/projects/${target.id}/rows`]: () => ok([dated]) });
    const open = vi.fn();
    const ui = renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Harness view="timeline" onOpen={open} /></MemoryRouter>); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await ui.user.click(await screen.findByRole('button', { name: task.title }));
    expect(open).toHaveBeenCalledWith(task.id);
    expect(document.querySelector('[data-gantt-movable]')).not.toBeInTheDocument();
    expect(screen.getByText(/Task details and status are shared. Custom fields belong to each project/)).toBeInTheDocument();
    expect(api.calls.some(call => /task-time-summary|planning|schedule/.test(call.path))).toBe(false);
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
