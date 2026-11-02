import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { HomeProjectPicker } from './HomeProjectPicker';
import { transferNotices } from './queries';
import { home, target, task } from './testFixtures';

const root = `/api/v1/workspaces/${alpha.id}`;
const url = `POST ${root}/tasks/${task.id}/transfer-project`;
const view = (disabled = false) => renderFieldUi(<HomeProjectPicker actorId={anna.id} task={task} homeProject={home} projects={[home, target]} disabled={disabled} />);
const moved = (over: Record<string, unknown> = {}) => ok({ task: { ...task, projectId: target.id, revision: task.revision + 1 }, movedTaskIds: [task.id], carriedValues: 2, notCarried: [{ fieldName: 'Fact', count: 3 }], ...over });

afterEach(() => transferNotices.clear(task.id));

describe('project dropdown of a task', () => {
  it('moves the task as soon as another project is chosen, then says what moved and offers the way back', async () => {
    const bodies: unknown[] = [];
    installFakeApi({ [url]: request => { bodies.push(request.body); return bodies.length === 1 ? moved() : ok({ task: { ...task, revision: task.revision + 2 }, movedTaskIds: [task.id], carriedValues: 0, notCarried: [] }); } });
    const ui = view();
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent(home.name);
    await ui.user.click(screen.getByRole('combobox', { name: 'Project' }));
    await ui.user.click(screen.getByRole('option', { name: target.name }));
    await waitFor(() => expect(bodies).toEqual([{ expectedRevision: task.revision, projectId: target.id }]));
    expect(await screen.findByText(`Moved to ${target.name}.`)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent(target.name);
    expect(screen.getByText('2 custom field values moved with it.')).toBeInTheDocument();
    expect(screen.getByText(/Not moved, no matching field in the new project: Fact \(3\)/)).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: `Move back to ${home.name}` }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ expectedRevision: task.revision + 1, projectId: home.id });
  });

  it('keeps the old project and names the fixed reason when the server refuses', async () => {
    installFakeApi({ [url]: () => new Response(JSON.stringify({ error: { code: 'DOMAIN_VALIDATION_FAILED', message: 'x', retryable: false, details: { fields: ['taskId'], transferReason: 'work_logs' } }, meta: { requestId: 'r' } }), { status: 422, headers: { 'content-type': 'application/json' } }) });
    const ui = view();
    await ui.user.click(screen.getByRole('combobox', { name: 'Project' }));
    await ui.user.click(screen.getByRole('option', { name: target.name }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The task has recorded work in its project, which cannot be moved.');
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent(home.name);
  });

  it('cannot be used while the pane is blocked', () => {
    installFakeApi({});
    view(true);
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeDisabled();
  });
  it('keeps the result and the way back when the task form is replaced while the project loads', async () => {
    installFakeApi({ [url]: () => moved() });
    const first = view();
    await first.user.click(screen.getByRole('combobox', { name: 'Project' }));
    await first.user.click(screen.getByRole('option', { name: target.name }));
    expect(await screen.findByText(`Moved to ${target.name}.`)).toBeInTheDocument();
    first.unmount();
    // The pane now shows the task in its new home, as a freshly mounted form.
    renderFieldUi(<HomeProjectPicker actorId={anna.id} task={{ ...task, projectId: target.id, revision: task.revision + 1 }} homeProject={target} projects={[home, target]} disabled={false} />);
    expect(screen.getByText(`Moved to ${target.name}.`)).toBeInTheDocument();
    expect(screen.getByText(/Not moved, no matching field in the new project: Fact \(3\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Move back to ${home.name}` })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Dismiss' }).then(button => button.click());
    await waitFor(() => expect(screen.queryByText(`Moved to ${target.name}.`)).not.toBeInTheDocument());
  });
});
