import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDto } from '@workloom/contracts';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { TaskProjectsField } from './TaskProjectsField';
import { transferNotices, usePlacementCommands } from './queries';
import { home, homePlacement, placement, target, task } from './testFixtures';

const root = `/api/v1/workspaces/${alpha.id}`;
const url = `POST ${root}/tasks/${task.id}/transfer-project`;
const moved = (over: Record<string, unknown> = {}) => ok({ task: { ...task, projectId: target.id, revision: task.revision + 1 }, movedTaskIds: [task.id], carriedValues: 2, notCarried: [{ fieldName: 'Fact', count: 3 }], ...over });
const refused = (reason: string) => () => new Response(JSON.stringify({ error: { code: 'DOMAIN_VALIDATION_FAILED', message: 'x', retryable: false, details: { fields: ['taskId'], transferReason: reason } }, meta: { requestId: 'r' } }), { status: 422, headers: { 'content-type': 'application/json' } });
const reads = { [`GET ${root}/projects`]: () => ok([home, target]), [`GET ${root}/tasks/${task.id}/placements`]: () => ok([homePlacement, placement]) };

function Field({ shown = task, homeProject = home }: { shown?: TaskDto; homeProject?: typeof home }) {
  const commands = usePlacementCommands(anna.id, alpha.id);
  return <TaskProjectsField actorId={anna.id} task={shown} homeProject={homeProject} writable commands={commands} />;
}
const makeHome = async (name: string) => {
  const button = await screen.findByRole('button', { name: `Make ${name} the home project` });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
};

afterEach(() => transferNotices.clear(task.id));

describe('home project in the task\'s project list', () => {
  it('marks the home project and makes another listed project the home in one click, keeping the former home', async () => {
    const bodies: unknown[] = [];
    installFakeApi({ ...reads, [url]: request => { bodies.push(request.body); return bodies.length === 1 ? moved() : ok({ task: { ...task, revision: task.revision + 2 }, movedTaskIds: [task.id], carriedValues: 0, notCarried: [] }); } });
    const ui = renderFieldUi(<Field />);
    const homeRow = (await screen.findByText(home.name)).parentElement;
    expect(within(homeRow as HTMLElement).getByText('Home')).toHaveAttribute('title', 'Hours and custom fields count in this project.');
    // The home itself has no such action and cannot be removed; nothing is a dropdown any more.
    expect(screen.queryByRole('button', { name: `Make ${home.name} the home project` })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
    await ui.user.click(await makeHome(target.name));
    await waitFor(() => expect(bodies).toEqual([{ expectedRevision: task.revision, projectId: target.id, keepFormerHome: true }]));
    expect(await screen.findByText(`${target.name} is now the home project.`)).toBeInTheDocument();
    expect(screen.getByText('2 custom field values moved to the new home.')).toBeInTheDocument();
    expect(screen.getByText(/Not moved, kept in the former project .*: Fact \(3\)/)).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: `Make ${home.name} the home again` }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ expectedRevision: task.revision + 1, projectId: home.id, keepFormerHome: true });
  });

  it('keeps the home and names the fixed reason when the server refuses', async () => {
    installFakeApi({ ...reads, [url]: refused('single_project_former') });
    const ui = renderFieldUi(<Field />);
    await ui.user.click(await makeHome(target.name));
    expect(await screen.findByRole('alert')).toHaveTextContent('The current home project keeps every task in one project only, so the task cannot stay there once another project is its home.');
    expect(screen.queryByText(`${target.name} is now the home project.`)).not.toBeInTheDocument();
  });

  it('offers no home change for a subtask, which always shares its parent\'s home', async () => {
    installFakeApi(reads);
    renderFieldUi(<Field shown={{ ...task, parentTaskId: placement.id }} />);
    expect(await screen.findByRole('button', { name: `Remove from ${target.name}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Make ${target.name} the home project` })).not.toBeInTheDocument();
    expect(screen.getByText('A subtask always has the same home as its parent task.')).toBeInTheDocument();
  });

  it('keeps the result and the way back when the task form is replaced while the new home loads', async () => {
    installFakeApi({ ...reads, [url]: () => moved() });
    const first = renderFieldUi(<Field />);
    await first.user.click(await makeHome(target.name));
    expect(await screen.findByText(`${target.name} is now the home project.`)).toBeInTheDocument();
    first.unmount();
    // The pane now shows the task with its new home, as a freshly mounted form.
    renderFieldUi(<Field shown={{ ...task, projectId: target.id, revision: task.revision + 1 }} homeProject={target} />);
    // Project names arrive with the project list; the result itself was kept outside the replaced form.
    expect(await screen.findByText(`${target.name} is now the home project.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Make ${home.name} the home again` })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Dismiss' }).then(button => button.click());
    await waitFor(() => expect(screen.queryByText(`${target.name} is now the home project.`)).not.toBeInTheDocument());
  });

  it('sends the task\'s current revision, not the one the earlier change answered with, after the task changed meanwhile', async () => {
    const bodies: unknown[] = [];
    installFakeApi({ ...reads, [url]: request => { bodies.push(request.body); return moved(); } });
    // The change answered with revision 2; the title was edited afterwards, so the pane now holds revision 3.
    transferNotices.set(task.id, { fromProjectId: home.id, result: { task: { ...task, projectId: target.id, revision: 2 }, movedTaskIds: [task.id], carriedValues: 0, notCarried: [] } });
    const ui = renderFieldUi(<Field shown={{ ...task, projectId: target.id, revision: 3 }} homeProject={target} />);
    const back = await screen.findByRole('button', { name: `Make ${home.name} the home again` });
    await waitFor(() => expect(back).toBeEnabled());
    await ui.user.click(back);
    await waitFor(() => expect(bodies).toEqual([{ expectedRevision: 3, projectId: home.id, keepFormerHome: true }]));
  });
});
