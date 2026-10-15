import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectDto, SectionDto, TagDto } from '@workloom/contracts';
import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RenameSectionDialog } from '../features/projects/SectionDialogs';
import { useUpdateSectionMutation } from '../features/projects/queries';
import { TagManagerDialog } from '../features/tasks/TagDialogs';
import { createQueryClient } from '../lib/queryClient';
import {
  alpha,
  alphaMembers,
  anna,
  created,
  installFakeApi,
  ok,
  project,
  renderApp,
  singleActorRoutes,
  type FakeRequest,
} from '../test/fakeApi';

/*
 * A sent name form is frozen on exactly what was sent while the command is pending or its outcome
 * is unknown, also after the form is closed and reopened. Real dialogs, hooks and QueryClient;
 * only fetch is replaced, and the first answer is held and then lost.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = 'e0000000-0000-4000-8000-000000000001';
const workspacePath = `/api/v1/workspaces/${alpha.id}`;

/** A held answer that is later lost in transport. */
function heldAnswer() {
  let lose: () => void = () => undefined;
  const promise = new Promise<Response>((_, reject) => {
    lose = () => reject(new TypeError('Failed to fetch'));
  });
  return { promise, lose };
}

function writesOf(calls: FakeRequest[], method: string) {
  const writes = calls.filter((call) => call.method === method);
  return { bodies: writes.map((call) => call.body), keys: writes.map((call) => call.headers.get('idempotency-key')) };
}

function renderWithClient(ui: ReactElement) {
  const queryClient = createQueryClient({ retry: false });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { queryClient, user };
}

function section(id: string, name: string): SectionDto {
  return { id, workspaceId: alpha.id, projectId: PROJECT_ID, name, position: 0, revision: 1, archivedAt: null };
}

function tag(id: string, name: string, color: string | null, revision = 1): TagDto {
  return { id, workspaceId: alpha.id, name, color, revision, archivedAt: null };
}

describe('pending and uncertain name forms', () => {
  it('keeps a project create frozen on the sent name until the resend is confirmed', async () => {
    const answer = heldAnswer();
    let projects: ProjectDto[] = [];
    let posts = 0;
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${workspacePath}/projects`]: () => ok(projects),
      [`POST ${workspacePath}/projects`]: () => {
        posts += 1;
        if (posts === 1) return answer.promise;
        const next = project(alpha.id, PROJECT_ID, 'Запуск сайта');
        projects = [next];
        return created(next);
      },
    });
    const { user } = renderApp(`/w/${alpha.id}/projects`);
    expect(await screen.findByRole('heading', { name: 'Проектов пока нет' })).toBeInTheDocument();
    const opener = screen.getByRole('button', { name: 'Новый проект' });
    const dialog = () => screen.getByRole('dialog', { name: 'Новый проект' });
    const field = () => within(dialog()).getByLabelText('Название проекта');

    await user.click(opener);
    await user.type(await screen.findByLabelText('Название проекта'), '  Запуск сайта ');
    await user.click(within(dialog()).getByRole('button', { name: 'Создать проект' }));
    expect(await within(dialog()).findByRole('button', { name: 'Сохраняем…' })).toBeInTheDocument();
    expect(field()).toHaveValue('Запуск сайта');
    expect(field()).toHaveAttribute('readonly');

    await user.type(field(), ' и блог');
    await user.click(within(dialog()).getByRole('button', { name: 'Сохраняем…' }));
    expect(field()).toHaveValue('Запуск сайта');
    expect(writesOf(calls, 'POST').bodies).toHaveLength(1);

    // Closing keeps the pending command; reopening shows what was sent.
    await user.click(within(dialog()).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(opener);
    expect(await screen.findByLabelText('Название проекта')).toHaveValue('Запуск сайта');
    expect(field()).toHaveAttribute('readonly');

    answer.lose();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Нет связи с сервером');
    expect(field()).toHaveValue('Запуск сайта');
    expect(field()).toHaveAttribute('readonly');

    await user.click(within(dialog()).getByRole('button', { name: 'Скрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(opener);
    expect(await screen.findByLabelText('Название проекта')).toHaveValue('Запуск сайта');

    await user.click(within(dialog()).getByRole('button', { name: 'Повторить отправку' }));
    expect(await screen.findByRole('link', { name: 'Запуск сайта' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const { bodies, keys } = writesOf(calls, 'POST');
    expect(bodies).toEqual([{ name: 'Запуск сайта' }, { name: 'Запуск сайта' }]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
  });

  it('keeps a section rename on its own section and blocks renaming another one meanwhile', async () => {
    const design = section('e0000000-0000-4000-8000-000000000011', 'Дизайн');
    const analytics = section('e0000000-0000-4000-8000-000000000012', 'Аналитика');
    const answer = heldAnswer();
    let patches = 0;
    const { calls } = installFakeApi({
      [`PATCH ${workspacePath}/sections/${design.id}`]: () => {
        patches += 1;
        return patches === 1 ? answer.promise : ok({ ...design, name: 'Дизайн и вёрстка', revision: 2 });
      },
    });

    function Page() {
      // Owned by the page, as in ProjectPage: one mutation for every section.
      const mutation = useUpdateSectionMutation(anna.id, alpha.id);
      const [renaming, setRenaming] = useState<SectionDto | null>(null);
      return (
        <>
          {[design, analytics].map((item) => (
            <button key={item.id} type="button" onClick={() => setRenaming(item)}>
              {`Открыть «${item.name}»`}
            </button>
          ))}
          <RenameSectionDialog
            actorId={anna.id}
            workspaceId={alpha.id}
            section={renaming}
            mutation={mutation}
            onClose={() => setRenaming(null)}
          />
        </>
      );
    }
    const { user } = renderWithClient(<Page />);
    const dialog = () => screen.getByRole('dialog', { name: 'Переименовать раздел' });
    const field = () => within(dialog()).getByLabelText('Название раздела');
    const open = async (name: string) => {
      await user.click(screen.getByRole('button', { name: `Открыть «${name}»` }));
      return screen.findByRole('dialog', { name: 'Переименовать раздел' });
    };
    const close = async (label: 'Отмена' | 'Скрыть') => {
      await user.click(within(dialog()).getByRole('button', { name: label }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    };

    await open('Дизайн');
    await user.clear(field());
    await user.type(field(), ' Дизайн и вёрстка  ');
    await user.click(within(dialog()).getByRole('button', { name: 'Сохранить' }));
    expect(await within(dialog()).findByRole('button', { name: 'Сохраняем…' })).toBeInTheDocument();
    expect(field()).toHaveValue('Дизайн и вёрстка');
    expect(field()).toHaveAttribute('readonly');
    await close('Отмена');

    // Another section is not shown with the pending name and cannot be sent.
    await open('Аналитика');
    expect(field()).toHaveValue('Аналитика');
    expect(field()).toHaveAttribute('readonly');
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Сохраняется переименование другого раздела');
    await user.click(within(dialog()).getByRole('button', { name: 'Сохранить' }));
    await close('Отмена');

    await open('Дизайн');
    expect(field()).toHaveValue('Дизайн и вёрстка');
    expect(field()).toHaveAttribute('readonly');

    answer.lose();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Нет связи с сервером');
    expect(field()).toHaveValue('Дизайн и вёрстка');
    expect(field()).toHaveAttribute('readonly');
    await close('Скрыть');

    await open('Аналитика');
    expect(field()).toHaveValue('Аналитика');
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Переименование другого раздела не подтверждено');
    await close('Отмена');

    await open('Дизайн');
    expect(field()).toHaveValue('Дизайн и вёрстка');
    await user.click(within(dialog()).getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const { bodies, keys } = writesOf(calls, 'PATCH');
    expect(bodies).toEqual([
      { expectedRevision: 1, name: 'Дизайн и вёрстка' },
      { expectedRevision: 1, name: 'Дизайн и вёрстка' },
    ]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
    expect(calls.filter((call) => call.path.endsWith(analytics.id))).toEqual([]);
  });

  it('keeps a tag create frozen on the sent name and color through hiding and a lost answer', async () => {
    const urgent = tag('e0000000-0000-4000-8000-000000000031', 'Срочно', '#ff0000');
    const answer = heldAnswer();
    let tags: TagDto[] = [];
    let posts = 0;
    const { calls } = installFakeApi({
      [`GET ${workspacePath}/tags`]: () => ok(tags),
      [`POST ${workspacePath}/tags`]: () => {
        posts += 1;
        if (posts === 1) return answer.promise;
        tags = [urgent];
        return created(urgent);
      },
    });
    const { user } = renderWithClient(<TagManagerDialog actorId={anna.id} workspaceId={alpha.id} canEdit />);
    const dialog = () => screen.getByRole('dialog', { name: 'Теги пространства' });
    const form = () => within(within(dialog()).getByRole('region', { name: 'Новый тег' }));
    const expectSent = () => {
      expect(form().getByLabelText('Название тега')).toHaveValue('Срочно');
      expect(form().getByLabelText('Название тега')).toHaveAttribute('readonly');
      expect(form().getByLabelText('Цвет')).toBeChecked();
      expect(form().getByLabelText('Цвет')).toBeDisabled();
      expect(form().getByLabelText('Цвет тега')).toHaveValue('#ff0000');
      expect(form().getByLabelText('Цвет тега')).toBeDisabled();
    };

    await user.click(screen.getByRole('button', { name: 'Теги' }));
    expect(await within(dialog()).findByText('Тегов пока нет.')).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Новый тег' }));
    await user.type(form().getByLabelText('Название тега'), '  Срочно ');
    await user.click(form().getByLabelText('Цвет'));
    fireEvent.change(form().getByLabelText('Цвет тега'), { target: { value: '#ff0000' } });
    await user.click(form().getByRole('button', { name: 'Создать тег' }));
    expect(await form().findByRole('button', { name: 'Сохраняем…' })).toBeInTheDocument();
    expectSent();

    await user.click(form().getByRole('button', { name: 'Отмена' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Новый тег' }));
    expectSent();

    answer.lose();
    expect(await form().findByRole('alert')).toHaveTextContent('Нет связи с сервером');
    expectSent();

    await user.click(within(dialog()).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Теги' }));
    await screen.findByRole('dialog', { name: 'Теги пространства' });
    expectSent();

    await user.click(form().getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() => expect(within(dialog()).queryByRole('region', { name: 'Новый тег' })).not.toBeInTheDocument());

    const { bodies, keys } = writesOf(calls, 'POST');
    expect(bodies).toEqual([
      { name: 'Срочно', color: '#ff0000' },
      { name: 'Срочно', color: '#ff0000' },
    ]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
  });

  it('reopens a tag edit with the submitted values, not a later refresh of the omitted color', async () => {
    const urgent = tag('e0000000-0000-4000-8000-000000000031', 'Срочно', '#ff0000');
    const later = tag('e0000000-0000-4000-8000-000000000032', 'Позже', null);
    const answer = heldAnswer();
    let tags: TagDto[] = [urgent, later];
    let patches = 0;
    const { calls } = installFakeApi({
      [`GET ${workspacePath}/tags`]: () => ok(tags),
      [`PATCH ${workspacePath}/tags/${urgent.id}`]: () => {
        patches += 1;
        return patches === 1 ? answer.promise : ok({ ...urgent, name: 'Очень срочно', color: '#00ff00', revision: 3 });
      },
    });
    const { queryClient, user } = renderWithClient(<TagManagerDialog actorId={anna.id} workspaceId={alpha.id} canEdit />);
    const dialog = () => screen.getByRole('dialog', { name: 'Теги пространства' });
    const name = () => within(dialog()).getByLabelText('Название тега');
    const color = () => within(dialog()).getByLabelText('Цвет тега');
    const button = (label: string) => within(dialog()).getByRole('button', { name: label });

    await user.click(screen.getByRole('button', { name: 'Теги' }));
    await user.click(await within(dialog()).findByRole('button', { name: 'Изменить тег «Срочно»' }));
    await user.clear(name());
    await user.type(name(), 'Очень срочно');
    await user.click(button('Сохранить'));
    expect(await within(dialog()).findByRole('button', { name: 'Сохраняем…' })).toBeInTheDocument();
    expect(name()).toHaveValue('Очень срочно');
    expect(name()).toHaveAttribute('readonly');

    // A colleague changes the color, which the pending command does not send.
    tags = [{ ...urgent, color: '#00ff00', revision: 2 }, later];
    await act(() => queryClient.invalidateQueries());
    await user.click(button('Отмена'));

    await user.click(button('Изменить тег «Позже»'));
    expect(name()).toHaveValue('Позже');
    expect(name()).toHaveAttribute('readonly');
    expect(within(dialog()).getByText(/^Сохраняется изменение другого тега/)).toBeInTheDocument();
    await user.click(button('Сохранить'));
    await user.click(button('Отмена'));

    await user.click(button('Изменить тег «Срочно»'));
    expect(name()).toHaveValue('Очень срочно');
    expect(color()).toHaveValue('#ff0000');
    expect(color()).toBeDisabled();

    answer.lose();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Нет связи с сервером');
    expect(name()).toHaveValue('Очень срочно');
    expect(color()).toHaveValue('#ff0000');

    await user.click(button('Повторить отправку'));
    await waitFor(() => expect(within(dialog()).queryByLabelText('Название тега')).not.toBeInTheDocument());

    const { bodies, keys } = writesOf(calls, 'PATCH');
    expect(bodies).toEqual([
      { expectedRevision: 1, name: 'Очень срочно' },
      { expectedRevision: 1, name: 'Очень срочно' },
    ]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
    expect(calls.filter((call) => call.path.endsWith(later.id))).toEqual([]);
  });
});
