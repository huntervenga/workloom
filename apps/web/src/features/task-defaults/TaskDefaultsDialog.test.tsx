import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskDefaultsDto, TaskStatusDto } from '@workloom/contracts';
import { alpha, alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { field, renderFieldUi, STAMP } from '../fields/test/fixtures';
import { TaskDefaultsDialog } from './TaskDefaultsDialog';

const PROJECT = '71000000-0000-4000-8000-000000000001';
const base = `/api/v1/workspaces/${alpha.id}`;
const status = (id: string, name: string, group: TaskStatusDto['group'], position: number): TaskStatusDto => ({ id, workspaceId: alpha.id, projectId: PROJECT, name, group, position, revision: 1 });
const todo = status('71000000-0000-4000-8000-0000000000a1', 'To do', 'todo', 0);
const doing = status('71000000-0000-4000-8000-0000000000a2', 'In progress', 'in_progress', 1);
const hours = { ...field('Hours Est', 'duration', '71000000-0000-4000-8000-0000000000b1'), projectId: PROJECT, updatedAt: STAMP };
const fact = { ...field('Hours Fact', 'duration', '71000000-0000-4000-8000-0000000000b2'), projectId: PROJECT };

function saved(revision = 0, config: Partial<TaskDefaultsDto['config']> = {}): TaskDefaultsDto {
  return { workspaceId: alpha.id, projectId: PROJECT, revision, config: { statusId: null, priority: null, estimateMinutes: null, fieldValues: [], ...config } };
}

describe('task defaults dialog', () => {
  it('saves status, priority, estimate and only the fields given a value', async () => {
    let body: unknown;
    installFakeApi({
      [`GET ${base}/projects/${PROJECT}/task-defaults`]: () => ok(saved()),
      [`GET ${base}/fields`]: () => ok([hours, fact]),
      [`GET ${base}/projects/${PROJECT}/statuses`]: () => ok([todo, doing]),
      [`GET ${base}/memberships`]: () => ok(alphaMembers),
      [`PUT ${base}/projects/${PROJECT}/task-defaults`]: request => { body = request.body; return ok(saved(1)); },
    });
    const ui = renderFieldUi(<TaskDefaultsDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT} canManage />);
    await ui.user.click(screen.getByRole('button', { name: 'New task defaults' }));
    const dialog = await screen.findByRole('dialog', { name: 'Defaults for new tasks' });
    await within(dialog).findByLabelText('Status');
    await ui.user.selectOptions(within(dialog).getByLabelText('Status'), doing.id);
    await ui.user.selectOptions(within(dialog).getByLabelText('Priority'), 'high');
    await ui.user.type(within(dialog).getByLabelText('Team estimate (hours)'), '1:30');
    await ui.user.type(within(dialog).getAllByRole('textbox')[1] as HTMLElement, '1');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ expectedRevision: 0, config: { statusId: doing.id, priority: 'high', estimateMinutes: 90, fieldValues: [{ fieldId: hours.id, value: { type: 'duration', value: 60 } }] } });
  });

  it('offers nothing to people who cannot manage fields', () => {
    installFakeApi({});
    renderFieldUi(<TaskDefaultsDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT} canManage={false} />);
    expect(screen.queryByRole('button', { name: 'New task defaults' })).not.toBeInTheDocument();
  });
});
