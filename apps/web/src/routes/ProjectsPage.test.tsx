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
    expect(await screen.findByRole('heading', { name: 'Проектов пока нет' })).toBeInTheDocument();

    const openButton = screen.getByRole('button', { name: 'Новый проект' });
    await user.click(openButton);
    const dialog = await screen.findByRole('dialog', { name: 'Новый проект' });
    const nameInput = within(dialog).getByLabelText('Название проекта');
    const submit = within(dialog).getByRole('button', { name: 'Создать проект' });

    await user.click(submit);
    expect(within(dialog).getByText('Введите название проекта.')).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');

    await user.type(nameInput, '  Запуск сайта ');
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Нет связи с сервером');
    expect(nameInput).toHaveValue('Запуск сайта');

    await user.click(submit);
    expect(await screen.findByRole('link', { name: 'Запуск сайта' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(openButton).toHaveFocus());

    // Creating another project with the same name is a new operation.
    await user.click(openButton);
    await user.type(await screen.findByLabelText('Название проекта'), 'Запуск сайта');
    await user.click(screen.getByRole('button', { name: 'Создать проект' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Запуск сайта' })).toHaveLength(2));

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

    await user.click(await screen.findByRole('button', { name: `Переименовать проект «${launch.name}»` }));
    const dialog = await screen.findByRole('dialog', { name: 'Переименовать проект' });
    const nameInput = within(dialog).getByLabelText('Название проекта');
    expect(nameInput).toHaveValue(launch.name);

    await user.clear(nameInput);
    await user.type(nameInput, 'Запуск лендинга');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Данные успели измениться');
    expect(document.body).not.toHaveTextContent('hunter2');
    expect(within(alert).queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    expect(nameInput).toHaveValue('Запуск лендинга');

    await user.click(within(alert).getByRole('button', { name: 'Загрузить актуальную версию' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('«Запуск (правка коллеги)»');
    expect(nameInput).toHaveValue('Запуск лендинга');

    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
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

    expect(await screen.findByRole('link', { name: 'Отчёт за квартал' })).toBeInTheDocument();
    expect(screen.getByText('Роль «Наблюдатель» позволяет только просматривать проекты.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Новый проект|Переименовать/ })).not.toBeInTheDocument();
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
    expect(await screen.findByRole('table', { name: `Задачи проекта «${launch.name}»` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Новая задача' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Таблица задач готовится' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Все проекты' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Проекты' })).toBeInTheDocument();
  });

  it('does not reveal a project the actor cannot see', async () => {
    const hidden = 'f0000000-0000-4000-8000-000000000009';
    installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${projectsPath}/${hidden}`]: () => failure(404, 'NOT_FOUND', `Project «Секретный» ${leakyMessage}`),
    });
    renderApp(`/w/${alpha.id}/projects/${hidden}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Проект недоступен' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К списку проектов' })).toHaveAttribute('href', `/w/${alpha.id}/projects`);
    expect(document.body).not.toHaveTextContent(/Секретный|hunter2/);
  });
});
