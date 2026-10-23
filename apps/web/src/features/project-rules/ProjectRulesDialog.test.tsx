import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { ProjectRulesDialog } from './ProjectRulesDialog';

const PROJECT = '74000000-0000-4000-8000-000000000001';
const path = `/api/v1/workspaces/${alpha.id}/projects/${PROJECT}/rules`;
const rules = (revision: number, singleProject: boolean) => ({ workspaceId: alpha.id, projectId: PROJECT, revision, config: { singleProject } });

describe('project rules dialog', () => {
  it('shows the rule off, saves it once with the seen revision and closes', async () => {
    let body: unknown; let current = rules(0, false);
    installFakeApi({ [`GET ${path}`]: () => ok(current), [`PUT ${path}`]: request => { body = request.body; current = rules(1, true); return ok(current); } });
    const ui = renderFieldUi(<ProjectRulesDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT} canManage />);
    await ui.user.click(screen.getByRole('button', { name: 'Project rules' }));
    const box = await screen.findByRole('checkbox', { name: /A task can belong to only one project/ });
    expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
    await ui.user.click(box);
    await ui.user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(body).toEqual({ expectedRevision: 0, config: { singleProject: true } }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
  });

  it('is absent for people who cannot manage the project', () => {
    installFakeApi({});
    renderFieldUi(<ProjectRulesDialog actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT} canManage={false} />);
    expect(screen.queryByRole('button', { name: 'Project rules' })).not.toBeInTheDocument();
  });
});
