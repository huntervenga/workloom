import { MemoryRouter } from 'react-router';
import { queryKeys } from '../../lib/queryKeys';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok, failure } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { TaskDrawer } from '../tasks/TaskDrawer';
import { useTaskCommands } from '../tasks/useTaskCommands';
import { home, homeDone, homePlacement, homeStatus, target, targetStatus, task } from './testFixtures';
const root = `/api/v1/workspaces/${alpha.id}`;
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
function Drawer() {
  const commands = useTaskCommands(anna.id, alpha.id, true);
  return <TaskDrawer actorId={anna.id} workspace={alpha} project={target} members={alphaMembers} statuses={[targetStatus]} sections={[]} tags={[]} writable commands={commands} onCreateChild={() => { throw new Error('Viewed-project child writer must not run'); }} loadedSubtasks={{ parentId: task.id, tasks: [], partial: false, includesArchived: false }} taskId={task.id} creating={null} onClose={() => undefined} onOpenTask={() => undefined} onResumeCreate={() => undefined} onCreated={() => undefined} onAnnounce={() => undefined} />;
}
function renderDrawer() { return renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/']}><Drawer /></MemoryRouter>); }
function routes() {
  return {
    [`GET ${root}/tasks/${task.id}`]: () => ok(task),
    [`GET ${root}/projects/${home.id}`]: () => ok(home),
    [`GET ${root}/projects/${home.id}/statuses`]: () => ok([homeStatus, homeDone]),
    [`GET ${root}/projects/${home.id}/sections`]: () => ok([]),
    [`GET ${root}/tasks/${task.id}/placements`]: () => ok([homePlacement]),
    [`GET ${root}/projects`]: () => ok([home, target]),
  };
}
describe('linked canonical task pane', () => {
  it('opens in the viewed project while using only home statuses and canonical revision for edits', async () => {
    const api = installFakeApi({ ...routes(), [`PATCH ${root}/tasks/${task.id}`]: () => ok({ ...task, statusId: homeDone.id, revision: task.revision + 1 }) });
    const ui = renderDrawer(); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await screen.findByLabelText('Task name');
    expect(screen.getByText(/Home: Canonical home · Viewing: Viewed project/)).toBeInTheDocument();
    expect(screen.queryByText(/\{\{?p[01]/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open home project' })).toHaveAttribute('href', `/app/w/${alpha.id}/projects/${home.id}?task=${task.id}`);
    expect(screen.queryByRole('button', { name: 'Add subtask' })).not.toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Status' });
    await waitFor(() => expect(picker).toBeEnabled());
    await ui.user.click(picker);
    const menu = screen.getByRole('listbox', { name: 'Status' });
    expect(within(menu).queryByRole('option', { name: 'Viewed todo' })).not.toBeInTheDocument();
    await ui.user.click(within(menu).getByRole('option', { name: 'Home done' }));
    await waitFor(() => expect(api.calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(api.calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: task.revision, statusId: homeDone.id });
    expect(api.calls.find(call => call.method === 'PATCH')?.path).toBe(`${root}/tasks/${task.id}`);
    expect(api.calls.some(call => call.method !== 'GET' && call.path.includes(`/projects/${target.id}`))).toBe(false);
  });
  it('keeps a typed draft unsent when a current home-project denial unmounts the form', async () => {
    let denied = false;
    const api = installFakeApi({ ...routes(), [`GET ${root}/projects/${home.id}`]: () => denied ? failure(403, 'FORBIDDEN', 'Denied') : ok(home) });
    const ui = renderDrawer(); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    const title = await screen.findByLabelText('Task name');
    fireEvent.change(title, { target: { value: 'Retained home draft' } });
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    denied = true;
    await act(async () => { await ui.client.invalidateQueries({ queryKey: queryKeys.project(anna.id, alpha.id, home.id), exact: true }); });
    await screen.findByText('The home project could not be verified. Shared task editing is unavailable until it reloads.');
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('offers no shared fields when current authorization to the home project is denied', async () => {
    const api = installFakeApi({ ...routes(), [`GET ${root}/projects/${home.id}`]: () => failure(403, 'FORBIDDEN', 'Denied') });
    const ui = renderDrawer(); cleanups.push(() => { ui.unmount(); ui.client.clear(); });
    await screen.findByText('The home project could not be verified. Shared task editing is unavailable until it reloads.');
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.calls.filter(call => call.path === `${root}/projects/${home.id}`)).toHaveLength(2));
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
  });
});
