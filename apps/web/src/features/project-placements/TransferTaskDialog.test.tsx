import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { TransferTaskDialog } from './TransferTaskDialog';
import { home, target, task } from './testFixtures';

const root = `/api/v1/workspaces/${alpha.id}`;
const url = `POST ${root}/tasks/${task.id}/transfer-project`;
const view = () => renderFieldUi(<TransferTaskDialog actorId={anna.id} task={task} homeProject={home} projects={[home, target]} disabled={false} />);

describe('moving a task to another project', () => {
  it('asks first, sends the revision and project once, and reports what moved and what stayed behind', async () => {
    let body: unknown; let calls = 0;
    installFakeApi({ [url]: request => { calls += 1; body = request.body; return ok({ task: { ...task, projectId: target.id }, movedTaskIds: [task.id], carriedValues: 2, notCarried: [{ fieldName: 'Fact', count: 3 }] }); } });
    const ui = view();
    await ui.user.click(screen.getByRole('button', { name: /Move to another project/ }));
    expect(screen.getByRole('button', { name: 'Move task' })).toBeDisabled();
    await ui.user.click(screen.getByRole('combobox', { name: 'Project to move to' }));
    await ui.user.click(screen.getByRole('option', { name: target.name }));
    expect(screen.getByText(/From now on its hours, plans and reports count in the new project/)).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Move task' }));
    await waitFor(() => expect(body).toEqual({ expectedRevision: task.revision, projectId: target.id }));
    expect(await screen.findByText(`Moved to ${target.name}.`)).toBeInTheDocument();
    expect(screen.getByText('2 custom field values moved with it.')).toBeInTheDocument();
    expect(screen.getByText(/Not moved, no matching field in the new project: Fact \(3\)/)).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('shows a fixed reason when the server refuses, and sends nothing else', async () => {
    installFakeApi({ [url]: () => new Response(JSON.stringify({ error: { code: 'DOMAIN_VALIDATION_FAILED', message: 'x', retryable: false, details: { fields: ['taskId'], transferReason: 'work_logs' } }, meta: { requestId: 'r' } }), { status: 422, headers: { 'content-type': 'application/json' } }) });
    const ui = view();
    await ui.user.click(screen.getByRole('button', { name: /Move to another project/ }));
    await ui.user.click(screen.getByRole('combobox', { name: 'Project to move to' }));
    await ui.user.click(screen.getByRole('option', { name: target.name }));
    await ui.user.click(screen.getByRole('button', { name: 'Move task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The task has recorded work in its project, which cannot be moved.');
    expect(screen.getByRole('button', { name: 'Move task' })).toBeEnabled();
  });

  it('is unavailable for a subtask and offers no move when there is no other project', () => {
    installFakeApi({});
    const subtask = { ...task, parentTaskId: 'e0000000-0000-4000-8000-0000000000aa' };
    const first = renderFieldUi(<TransferTaskDialog actorId={anna.id} task={subtask} homeProject={home} projects={[home, target]} disabled={false} />);
    expect(screen.getByRole('button', { name: /Move to another project/ })).toBeDisabled();
    first.unmount();
    renderFieldUi(<TransferTaskDialog actorId={anna.id} task={task} homeProject={home} projects={[home]} disabled={false} />);
    expect(screen.getByRole('button', { name: /Move to another project/ })).toBeDisabled();
  });
});
