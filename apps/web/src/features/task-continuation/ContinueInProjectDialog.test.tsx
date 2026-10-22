import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok, created, project } from '../../test/fakeApi';
import { task as baseTask } from '../planning/test/fixtures';
import { renderFieldUi } from '../fields/test/fixtures';
import { ContinueInProjectDialog } from './ContinueInProjectDialog';

const SOURCE = '73000000-0000-4000-8000-000000000003';
const OTHER = '73000000-0000-4000-8000-000000000002';

describe('continue in another project', () => {
  it('previews the numbered title, sends the chosen project once and offers the new task', async () => {
    let body: unknown;
    const task = { ...baseTask, title: 'Rework billing 2', workspaceId: alpha.id, projectId: SOURCE };
    const done = { ...task, id: task.id };
    installFakeApi({
      [`GET /api/v1/workspaces/${alpha.id}/projects`]: () => ok([project(alpha.id, task.projectId, 'Week 1'), project(alpha.id, OTHER, 'Week 2')]),
      [`POST /api/v1/workspaces/${alpha.id}/tasks/${task.id}/continue`]: request => { body = request.body; return created({ closed: done, continued: { ...task, id: '73000000-0000-4000-8000-000000000009', title: 'Rework billing 3', projectId: OTHER }, dependencyId: '73000000-0000-4000-8000-0000000000aa' }); },
    });
    const ui = renderFieldUi(<MemoryRouter><ContinueInProjectDialog actorId={anna.id} workspaceId={alpha.id} task={task} currentProjectId={task.projectId} onClose={() => undefined} /></MemoryRouter>);
    expect(await screen.findByLabelText('Name of the new task')).toHaveValue('Rework billing 3');
    await waitFor(() => expect(document.body.textContent).toContain('Week 2'));
    await ui.user.selectOptions(screen.getByLabelText('Continue in project'), OTHER);
    await ui.user.click(screen.getByRole('button', { name: 'Close and continue in Week 2' }));
    await waitFor(() => expect(body).toEqual({ targetProjectId: OTHER, title: 'Rework billing 3' }));
    expect(await screen.findByText('Done. “Rework billing 3” was created in Week 2.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the new task' }).getAttribute('href')).toContain(`/projects/${OTHER}?task=`);
  });
});
