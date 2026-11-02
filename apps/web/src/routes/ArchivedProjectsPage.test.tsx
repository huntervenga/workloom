import './ProjectPage';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { ProjectDto } from '@workloom/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_ID, rootPath, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
import { alpha, anna, deferred, installFakeApi, ok, project, renderApp, singleActorRoutes } from '../test/fakeApi';

const projectsPath = `/api/v1/workspaces/${alpha.id}/projects`;
const old: ProjectDto = { ...project(alpha.id, 'e0000000-0000-4000-8000-0000000000a1', 'Backlog'), archivedAt: '2026-11-01T10:00:00.000Z' };

beforeAll(async () => { await import('./ProjectPage'); });

describe('archived projects', () => {
  it('lists archived projects and deletes one only after its exact name is typed', async () => {
    let gone = false;
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha]),
      [`GET ${projectsPath}`]: request => ok(request.searchParams.get('includeArchived') === 'true' && !gone ? [old] : []),
      [`POST ${projectsPath}/${old.id}/purge`]: () => { gone = true; return ok({ deleted: { projects: 1, tasks: 521 } }); },
    });
    const { user } = renderApp(`/w/${alpha.id}/projects/archive`);
    const row = (await screen.findByRole('link', { name: 'Backlog' })).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Delete forever/ }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /Delete forever/ });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type the project name/), 'Backlo');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type the project name/), 'g');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(calls.some(call => call.method === 'POST' && call.path.endsWith('/purge'))).toBe(true));
    const purge = calls.find(call => call.path.endsWith('/purge'));
    expect(purge?.body).toEqual({ confirmName: 'Backlog' });
    expect(await screen.findByText('No archived projects.')).toBeInTheDocument();
  });

  it('asks before archiving a project and only then sends the archive command', async () => {
    let patched: unknown = null;
    const { calls } = installFakeApi({
      ...tableRoutes(),
      [`PATCH ${rootPath}/projects/${PROJECT_ID}`]: request => { patched = request.body; return ok({ ...project(alpha.id, PROJECT_ID, 'Sprint', 2), archivedAt: '2026-11-02T10:00:00.000Z' }); },
    });
    const { user } = renderApp(tablePath);
    await screen.findByRole('heading', { level: 1 }); await user.click(screen.getByLabelText('Project actions', { selector: 'summary' }));
    await user.click(await screen.findByRole('button', { name: 'Archive project' }));
    expect(patched).toBeNull();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(patched).toMatchObject({ archived: true }));
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('locks the delete dialog behind a progress overlay until the server answers', async () => {
    const gate = deferred<Response>();
    installFakeApi({
      ...singleActorRoutes(anna, [alpha]),
      [`GET ${projectsPath}`]: () => ok([old]),
      [`POST ${projectsPath}/${old.id}/purge`]: () => gate.promise,
    });
    const { user } = renderApp(`/w/${alpha.id}/projects/archive`);
    await user.click(within((await screen.findByRole('link', { name: 'Backlog' })).closest('li') as HTMLElement).getByRole('button', { name: /Delete forever/ }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/Type the project name/);
    await user.type(input, 'Backlog');
    await user.click(within(dialog).getByRole('button', { name: /Delete forever/ }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(/Deleting the project/);
    expect(input).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => gate.resolve(ok({ deleted: { projects: 1 } })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
