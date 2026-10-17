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
    expect(await screen.findByRole('heading', { name: "No projects yet" })).toBeInTheDocument();
    const opener = screen.getByRole('button', { name: "New project" });
    const dialog = () => screen.getByRole('dialog', { name: "New project" });
    const field = () => within(dialog()).getByLabelText("Project name");

    await user.click(opener);
    await user.type(await screen.findByLabelText("Project name"), '  Запуск сайта ');
    await user.click(within(dialog()).getByRole('button', { name: "Create project" }));
    expect(await within(dialog()).findByRole('button', { name: "Saving…" })).toBeInTheDocument();
    expect(field()).toHaveValue('Запуск сайта');
    expect(field()).toHaveAttribute('readonly');

    await user.type(field(), ' и блог');
    await user.click(within(dialog()).getByRole('button', { name: "Saving…" }));
    expect(field()).toHaveValue('Запуск сайта');
    expect(writesOf(calls, 'POST').bodies).toHaveLength(1);

    // Closing keeps the pending command; reopening shows what was sent.
    await user.click(within(dialog()).getByRole('button', { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(opener);
    expect(await screen.findByLabelText("Project name")).toHaveValue('Запуск сайта');
    expect(field()).toHaveAttribute('readonly');

    answer.lose();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expect(field()).toHaveValue('Запуск сайта');
    expect(field()).toHaveAttribute('readonly');

    await user.click(within(dialog()).getByRole('button', { name: "Hide" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(opener);
    expect(await screen.findByLabelText("Project name")).toHaveValue('Запуск сайта');

    await user.click(within(dialog()).getByRole('button', { name: "Retry same change" }));
    expect(await within(screen.getByRole('main')).findByRole('link', { name: 'Запуск сайта' })).toBeInTheDocument();
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
    const dialog = () => screen.getByRole('dialog', { name: "Rename section" });
    const field = () => within(dialog()).getByLabelText("Section name");
    const open = async (name: string) => {
      await user.click(screen.getByRole('button', { name: `Открыть «${name}»` }));
      return screen.findByRole('dialog', { name: "Rename section" });
    };
    const close = async (label: "Cancel" | "Hide") => {
      await user.click(within(dialog()).getByRole('button', { name: label }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    };

    await open('Дизайн');
    await user.clear(field());
    await user.type(field(), ' Дизайн и вёрстка  ');
    await user.click(within(dialog()).getByRole('button', { name: "Save" }));
    expect(await within(dialog()).findByRole('button', { name: "Saving…" })).toBeInTheDocument();
    expect(field()).toHaveValue('Дизайн и вёрстка');
    expect(field()).toHaveAttribute('readonly');
    await close("Cancel");

    // Another section is not shown with the pending name and cannot be sent.
    await open('Аналитика');
    expect(field()).toHaveValue('Аналитика');
    expect(field()).toHaveAttribute('readonly');
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Another section is being renamed');
    await user.click(within(dialog()).getByRole('button', { name: "Save" }));
    await close("Cancel");

    await open('Дизайн');
    expect(field()).toHaveValue('Дизайн и вёрстка');
    expect(field()).toHaveAttribute('readonly');

    answer.lose();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expect(field()).toHaveValue('Дизайн и вёрстка');
    expect(field()).toHaveAttribute('readonly');
    await close("Hide");

    await open('Аналитика');
    expect(field()).toHaveValue('Аналитика');
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Another section rename is unconfirmed');
    await close("Cancel");

    await open('Дизайн');
    expect(field()).toHaveValue('Дизайн и вёрстка');
    await user.click(within(dialog()).getByRole('button', { name: "Retry same change" }));
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
    const dialog = () => screen.getByRole('dialog', { name: "Workspace tags" });
    const form = () => within(within(dialog()).getByRole('region', { name: "New tag" }));
    const expectSent = () => {
      expect(form().getByLabelText("Tag name")).toHaveValue('Срочно');
      expect(form().getByLabelText("Tag name")).toHaveAttribute('readonly');
      expect(form().getByLabelText("Color")).toBeChecked();
      expect(form().getByLabelText("Color")).toBeDisabled();
      expect(form().getByLabelText("Tag color")).toHaveValue('#ff0000');
      expect(form().getByLabelText("Tag color")).toBeDisabled();
    };

    await user.click(screen.getByRole('button', { name: "Tags" }));
    expect(await within(dialog()).findByText("No tags yet.")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: "New tag" }));
    await user.type(form().getByLabelText("Tag name"), '  Срочно ');
    await user.click(form().getByLabelText("Color"));
    fireEvent.change(form().getByLabelText("Tag color"), { target: { value: '#ff0000' } });
    await user.click(form().getByRole('button', { name: "Create tag" }));
    expect(await form().findByRole('button', { name: "Saving…" })).toBeInTheDocument();
    expectSent();

    await user.click(form().getByRole('button', { name: "Cancel" }));
    await user.click(within(dialog()).getByRole('button', { name: "New tag" }));
    expectSent();

    answer.lose();
    expect(await form().findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expectSent();

    await user.click(within(dialog()).getByRole('button', { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: "Tags" }));
    await screen.findByRole('dialog', { name: "Workspace tags" });
    expectSent();

    await user.click(form().getByRole('button', { name: "Retry submission" }));
    await waitFor(() => expect(within(dialog()).queryByRole('region', { name: "New tag" })).not.toBeInTheDocument());

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
    const dialog = () => screen.getByRole('dialog', { name: "Workspace tags" });
    const name = () => within(dialog()).getByLabelText("Tag name");
    const color = () => within(dialog()).getByLabelText("Tag color");
    const button = (label: string) => within(dialog()).getByRole('button', { name: label });

    await user.click(screen.getByRole('button', { name: "Tags" }));
    await user.click(await within(dialog()).findByRole('button', { name: "Edit tag “Срочно”" }));
    await user.clear(name());
    await user.type(name(), 'Очень срочно');
    await user.click(button("Save"));
    expect(await within(dialog()).findByRole('button', { name: "Saving…" })).toBeInTheDocument();
    expect(name()).toHaveValue('Очень срочно');
    expect(name()).toHaveAttribute('readonly');

    // A colleague changes the color, which the pending command does not send.
    tags = [{ ...urgent, color: '#00ff00', revision: 2 }, later];
    await act(() => queryClient.invalidateQueries());
    await user.click(button("Cancel"));

    await user.click(button("Edit tag “Позже”"));
    expect(name()).toHaveValue('Позже');
    expect(name()).toHaveAttribute('readonly');
    expect(within(dialog()).getByText(/^Another tag is being saved/)).toBeInTheDocument();
    await user.click(button("Save"));
    await user.click(button("Cancel"));

    await user.click(button("Edit tag “Срочно”"));
    expect(name()).toHaveValue('Очень срочно');
    expect(color()).toHaveValue('#ff0000');
    expect(color()).toBeDisabled();

    answer.lose();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expect(name()).toHaveValue('Очень срочно');
    expect(color()).toHaveValue('#ff0000');

    await user.click(button("Retry submission"));
    await waitFor(() => expect(within(dialog()).queryByLabelText("Tag name")).not.toBeInTheDocument());

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
