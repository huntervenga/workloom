// Resolve the lazy detail route during module loading, before the DOM assertion deadlines.
import './ProjectPage';
import { t } from '../i18n';
import { screen, waitFor, within } from '@testing-library/react';
import type { ProjectDto, WorkspaceDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import {
  alpha,
  alphaMembers,
  anna,
  beta,
  created,
  failure,
  installFakeApi,
  ok,
  project,
  renderApp,
  singleActorRoutes,
} from '../test/fakeApi';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const leakyMessage = "update projects set name = 'x' -- token sk_live_hunter2";
const projectsPath = `/api/v1/workspaces/${alpha.id}/projects`;
const launch = project(alpha.id, 'e0000000-0000-4000-8000-000000000001', 'Запуск сайта');

describe('projects', () => {
  it('shows project dates in the workspace timezone without shifting planned calendar dates', async () => {
    const workspace = { ...alpha, timezone: 'America/Los_Angeles' };
    const release: ProjectDto = {
      ...launch, name: 'Release',
      createdAt: '2026-10-01T00:30:00.000Z',
      updatedAt: '2026-10-03T02:00:00.000Z',
      dateRange: { from: '2026-10-01', to: '2026-10-20' },
    };
    installFakeApi({ ...singleActorRoutes(anna, [workspace]), [`GET ${projectsPath}`]: () => ok([release]) });
    renderApp(`/w/${alpha.id}/projects`);
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent))
      .toEqual(['Name', 'Created', 'Updated', 'Start date', 'End date', 'Status', 'Actions']);
    const row = within(table).getByRole('row', { name: /Release/ });
    expect(within(row).getByText('Sep 30, 2026')).toHaveAttribute('datetime', release.createdAt);
    expect(within(row).getByText('Oct 2, 2026')).toHaveAttribute('datetime', release.updatedAt);
    expect(within(row).getByText('Oct 1, 2026')).toHaveAttribute('datetime', '2026-10-01');
    expect(within(row).getByText('Oct 20, 2026')).toHaveAttribute('datetime', '2026-10-20');
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Release' })).toHaveAttribute('href', `/w/${alpha.id}/projects/${release.id}`);
  });

  it('sorts each column in both directions, keeping absent planned dates last', async () => {
    const first: ProjectDto = { ...launch, name: 'Alpha', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z', dateRange: { from: '2026-11-01', to: '2026-11-05' } };
    const second: ProjectDto = { ...project(alpha.id, 'e0000000-0000-4000-8000-000000000002', 'project 2'), createdAt: '2026-10-03T08:00:00.000Z', updatedAt: '2026-10-04T09:00:00.000Z', dateRange: { from: '2026-10-01', to: '2026-12-20' }, archivedAt: '2026-10-04T09:00:00.000Z' };
    const third: ProjectDto = { ...project(alpha.id, 'e0000000-0000-4000-8000-000000000003', 'Project 10'), createdAt: '2026-10-03T09:00:00.000Z', updatedAt: '2026-10-06T09:00:00.000Z' };
    const fourth: ProjectDto = { ...project(alpha.id, 'e0000000-0000-4000-8000-000000000004', 'Zulu'), createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-10-10T09:00:00.000Z', dateRange: null };
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha]), [`GET ${projectsPath}`]: () => ok([fourth, third, second, first]) });
    const { user } = renderApp(`/w/${alpha.id}/projects`);
    const table = await screen.findByRole('table', { name: 'Projects' });
    const names = () => within(table).getAllByRole('link').map(link => link.textContent);
    expect(names()).toEqual(['Alpha', 'project 2', 'Project 10', 'Zulu']);
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    await user.click(within(table).getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Zulu', 'Project 10', 'project 2', 'Alpha']);
    const cases = [
      { column: 'Created', initial: 'descending', first: ['Project 10', 'project 2', 'Alpha', 'Zulu'], second: ['Zulu', 'Alpha', 'project 2', 'Project 10'] },
      { column: 'Updated', initial: 'descending', first: ['Zulu', 'Project 10', 'Alpha', 'project 2'], second: ['project 2', 'Alpha', 'Project 10', 'Zulu'] },
      { column: 'Start date', initial: 'ascending', first: ['project 2', 'Alpha', 'Project 10', 'Zulu'], second: ['Alpha', 'project 2', 'Project 10', 'Zulu'] },
      { column: 'End date', initial: 'ascending', first: ['Alpha', 'project 2', 'Project 10', 'Zulu'], second: ['project 2', 'Alpha', 'Project 10', 'Zulu'] },
      { column: 'Status', initial: 'ascending', first: ['Alpha', 'Project 10', 'Zulu', 'project 2'], second: ['project 2', 'Alpha', 'Project 10', 'Zulu'] },
    ];
    for (const check of cases) {
      const button = within(table).getByRole('button', { name: check.column });
      await user.click(button);
      expect(names()).toEqual(check.first);
      expect(within(table).getByRole('columnheader', { name: check.column })).toHaveAttribute('aria-sort', check.initial);
      await user.click(button);
      expect(names()).toEqual(check.second);
      expect(within(table).getByRole('columnheader', { name: check.column })).toHaveAttribute('aria-sort', check.initial === 'ascending' ? 'descending' : 'ascending');
    }
    expect(within(table).getAllByText('Not set')).toHaveLength(4);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('resends a failed create with the same Idempotency-Key and starts a new key after success', async () => {
    let projects: ProjectDto[] = [];
    let posts = 0;
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${projectsPath}`]: () => ok(projects),
      [`POST ${projectsPath}`]: () => {
        posts += 1;
        if (posts === 1) return Promise.reject(new TypeError('Failed to fetch'));
        const next = project(alpha.id, `e0000000-0000-4000-8000-00000000000${posts}`, 'Запуск сайта');
        projects = [...projects, next];
        return created(next);
      },
    });
    const { user } = renderApp(`/w/${alpha.id}/projects`);
    expect(await screen.findByRole('heading', { name: "No projects yet" })).toBeInTheDocument();

    const openButton = screen.getByRole('button', { name: "New project" });
    await user.click(openButton);
    const dialog = await screen.findByRole('dialog', { name: "New project" });
    const nameInput = within(dialog).getByLabelText("Project name");
    const submit = within(dialog).getByRole('button', { name: "Create project" });

    await user.click(submit);
    expect(within(dialog).getByText("Enter a project name.")).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');

    await user.type(nameInput, '  Запуск сайта ');
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expect(nameInput).toHaveValue('Запуск сайта');

    await user.click(submit);
    // The sidebar repeats active projects; the page's own list is in the main landmark.
    expect(await within(screen.getByRole('main')).findByRole('link', { name: 'Запуск сайта' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(openButton).toHaveFocus());

    // Creating another project with the same name is a new operation.
    await user.click(openButton);
    await user.type(await screen.findByLabelText("Project name"), 'Запуск сайта');
    await user.click(screen.getByRole('button', { name: "Create project" }));
    await waitFor(() => expect(within(screen.getByRole('main')).getAllByRole('link', { name: 'Запуск сайта' })).toHaveLength(2));

    const writes = calls.filter((call) => call.method === 'POST');
    const keys = writes.map((call) => call.headers.get('idempotency-key'));
    expect(writes.map((call) => call.body)).toEqual([{ name: 'Запуск сайта' }, { name: 'Запуск сайта' }, { name: 'Запуск сайта' }]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(UUID);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('keeps the typed name through a rename conflict and saves against the reloaded revision', async () => {
    const colleague = { ...launch, name: 'Запуск (правка коллеги)', revision: 2 };
    let patches = 0;
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${projectsPath}`]: () => ok([patches < 2 ? launch : { ...launch, name: 'Запуск лендинга', revision: 3 }]),
      [`GET ${projectsPath}/${launch.id}`]: () => ok(colleague),
      [`PATCH ${projectsPath}/${launch.id}`]: () => {
        patches += 1;
        return patches === 1
          ? failure(409, 'REVISION_CONFLICT', leakyMessage)
          : ok({ ...launch, name: 'Запуск лендинга', revision: 3 });
      },
    });
    const { user } = renderApp(`/w/${alpha.id}/projects`);

    await user.click(await screen.findByRole('button', { name: t('routes.renameProject', { name: launch.name }) }));
    const dialog = await screen.findByRole('dialog', { name: "Rename project" });
    const nameInput = within(dialog).getByLabelText("Project name");
    expect(nameInput).toHaveValue(launch.name);

    await user.clear(nameInput);
    await user.type(nameInput, 'Запуск лендинга');
    await user.click(within(dialog).getByRole('button', { name: "Save" }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('This data changed elsewhere');
    expect(document.body).not.toHaveTextContent('hunter2');
    expect(within(alert).queryByRole('button', { name: "Try again" })).not.toBeInTheDocument();
    expect(nameInput).toHaveValue('Запуск лендинга');

    await user.click(within(alert).getByRole('button', { name: "Load latest version" }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('“Запуск (правка коллеги)”');
    expect(nameInput).toHaveValue('Запуск лендинга');

    await user.click(within(dialog).getByRole('button', { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const writes = calls.filter((call) => call.method === 'PATCH');
    expect(writes.map((call) => call.body)).toEqual([
      { expectedRevision: 1, name: 'Запуск лендинга' },
      { expectedRevision: 2, name: 'Запуск лендинга' },
    ]);
    expect(writes[1]?.headers.get('idempotency-key')).not.toBe(writes[0]?.headers.get('idempotency-key'));
  });

  it('shows projects read-only to a viewer', async () => {
    const watched: WorkspaceDto = { ...beta, role: 'viewer' };
    installFakeApi({
      ...singleActorRoutes(anna, [watched]),
      [`GET /api/v1/workspaces/${watched.id}/projects`]: () => ok([project(watched.id, launch.id, 'Отчёт за квартал')]),
    });
    renderApp(`/w/${watched.id}/projects`);

    expect(await within(await screen.findByRole('main')).findByRole('link', { name: 'Отчёт за квартал' })).toBeInTheDocument();
    expect(screen.getByText("Your Viewer role allows you to view projects.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New project|Rename/ })).not.toBeInTheDocument();
  });

  it('opens a project by its real name without inventing tasks', async () => {
    installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${projectsPath}`]: () => ok([launch]),
      [`GET ${projectsPath}/${launch.id}`]: () => ok(launch),
      [`GET ${projectsPath}/${launch.id}/sections`]: () => ok([]),
      [`GET ${projectsPath}/${launch.id}/statuses`]: () => ok([]),
      [`GET /api/v1/workspaces/${alpha.id}/tags`]: () => ok([]),
      [`GET /api/v1/workspaces/${alpha.id}/tasks`]: () => ok([]),
    });
    const { user } = renderApp(`/w/${alpha.id}/projects/${launch.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: launch.name })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: t('projects.projectPage.tasksInValue', { p0: launch.name }) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('projects.projectPage.newTask') })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Таблица задач готовится' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: "All projects" }));
    expect(await screen.findByRole('heading', { level: 1, name: "Projects" })).toBeInTheDocument();
  });

  it('does not reveal a project the actor cannot see', async () => {
    const hidden = 'f0000000-0000-4000-8000-000000000009';
    installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${projectsPath}/${hidden}`]: () => failure(404, 'NOT_FOUND', `Project «Секретный» ${leakyMessage}`),
    });
    renderApp(`/w/${alpha.id}/projects/${hidden}`);

    expect(await screen.findByRole('heading', { level: 1, name: "Project unavailable" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Back to projects" })).toHaveAttribute('href', `/w/${alpha.id}/projects`);
    expect(document.body).not.toHaveTextContent(/Секретный|hunter2/);
  });
});
