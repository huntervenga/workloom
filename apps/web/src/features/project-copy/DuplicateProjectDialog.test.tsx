import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, created, ok, project } from '../../test/fakeApi';
import { task as baseTask } from '../planning/test/fixtures';
import { renderFieldUi } from '../fields/test/fixtures';
import { DuplicateProjectDialog } from './DuplicateProjectDialog';

const SOURCE = '72000000-0000-4000-8000-000000000001';
const NEW = '72000000-0000-4000-8000-000000000002';

describe('duplicate project dialog', () => {
  it('suggests the next week, sends the chosen parts once and offers the new project', async () => {
    let body: unknown;
    installFakeApi({
      [`POST /api/v1/workspaces/${alpha.id}/projects/${SOURCE}/duplicate`]: request => {
        body = request.body;
        return created({ projectId: NEW, name: '43 week (since 26 October 2026) Planning', copied: { sections: 5, fields: 3, aggregates: false, checkRules: 2, defaults: true, reports: 0, workCategory: false }, warnings: [{ part: 'reports', message: 'Saved reports could not be copied.' }] });
      },
    });
    const ui = renderFieldUi(<MemoryRouter><DuplicateProjectDialog actorId={anna.id} workspaceId={alpha.id} canManage project={project(alpha.id, SOURCE, '42 week (since 19 October 2026) Planning')} /></MemoryRouter>);
    await ui.user.click(screen.getByRole('button', { name: 'Create next copy' }));
    const name = await screen.findByLabelText('Name of the new project');
    expect(name).toHaveValue('43 week (since 26 October 2026) Planning');
    expect(screen.getByLabelText('Move dates by (days)')).toHaveValue('7');
    await ui.user.click(screen.getByLabelText('Saved reports'));
    await ui.user.click(screen.getByRole('button', { name: 'Create copy' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ name: '43 week (since 26 October 2026) Planning', shiftDays: 7, copy: { aggregates: true, checks: true, defaults: true, reports: false, workCategory: true } });
    expect(await screen.findByText('“43 week (since 26 October 2026) Planning” is ready.')).toBeInTheDocument();
    expect(screen.getByText('2 planning check(s) copied.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Saved reports could not be copied.');
    expect(screen.getByRole('link', { name: 'Open the new project' }).getAttribute('href')).toContain(`/projects/${NEW}`);
  });

  it('offers to carry the unfinished tasks into the new copy, with that project already chosen', async () => {
    installFakeApi({
      [`GET /api/v1/workspaces/${alpha.id}/projects`]: () => ok([project(alpha.id, SOURCE, 'Week 1'), project(alpha.id, NEW, 'Week 2')]),
      [`POST /api/v1/workspaces/${alpha.id}/projects/${SOURCE}/duplicate`]: () => created({ projectId: NEW, name: 'Week 2', copied: { sections: 1, fields: 0, aggregates: false, checkRules: 0, defaults: false, reports: 0, workCategory: false }, warnings: [] }),
    });
    const open = [{ ...baseTask, id: '72000000-0000-4000-8000-000000000101', title: 'Unfinished one', workspaceId: alpha.id, projectId: SOURCE }, { ...baseTask, id: '72000000-0000-4000-8000-000000000102', title: 'Unfinished two', workspaceId: alpha.id, projectId: SOURCE }];
    const ui = renderFieldUi(<MemoryRouter><DuplicateProjectDialog actorId={anna.id} workspaceId={alpha.id} canManage unfinished={open} project={project(alpha.id, SOURCE, 'Week 1')} /></MemoryRouter>);
    await ui.user.click(screen.getByRole('button', { name: 'Create next copy' }));
    await ui.user.click(await screen.findByRole('button', { name: 'Create copy' }));
    await ui.user.click(await screen.findByRole('button', { name: 'Carry over 2 unfinished tasks…' }));
    expect(await screen.findByRole('heading', { name: 'Continue 2 tasks in another project' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Continue in project')).toHaveValue(NEW));
    expect(screen.getByText('Unfinished two')).toBeInTheDocument();
  });

  it('is absent for people who cannot manage fields', () => {
    installFakeApi({});
    renderFieldUi(<MemoryRouter><DuplicateProjectDialog actorId={anna.id} workspaceId={alpha.id} canManage={false} project={project(alpha.id, SOURCE, 'x')} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Create next copy' })).not.toBeInTheDocument();
  });
});
