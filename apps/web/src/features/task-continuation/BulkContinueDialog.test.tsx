import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { alpha, anna, created, failure, installFakeApi, ok, project } from '../../test/fakeApi';
import { task as baseTask } from '../planning/test/fixtures';
import { renderFieldUi } from '../fields/test/fixtures';
import { BulkContinueDialog } from './BulkContinueDialog';

const SOURCE = '73000000-0000-4000-8000-000000000003';
const OTHER = '73000000-0000-4000-8000-000000000002';
const make = (n: number, title: string) => ({ ...baseTask, id: `73000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, title, workspaceId: alpha.id, projectId: SOURCE });

describe('continue a selection in another project', () => {
  it('sends one command per task with its own key, reports a refusal beside its task and lets the rest be retried', async () => {
    const tasks = [make(1, 'First'), make(2, 'Second'), make(3, 'Third')];
    const calls: { id: string; key: string | null; body: unknown }[] = [];
    let secondFails = true;
    const routes: Record<string, (request: { body: unknown; headers?: Record<string, string> }) => Response> = {
      [`GET /api/v1/workspaces/${alpha.id}/projects`]: () => ok([project(alpha.id, SOURCE, 'Week 1'), project(alpha.id, OTHER, 'Week 2')]),
    };
    for (const task of tasks) routes[`POST /api/v1/workspaces/${alpha.id}/tasks/${task.id}/continue`] = request => {
      calls.push({ id: task.id, key: (request as unknown as { headers: Headers }).headers?.get?.('idempotency-key') ?? null, body: request.body });
      if (task.title === 'Second' && secondFails) return failure(422, 'DOMAIN_VALIDATION_FAILED', 'The chosen project is archived.');
      return created({ closed: task, continued: { ...task, id: task.id.replace('0000000001', '0000000002'), title: `${task.title} 2`, projectId: OTHER }, dependencyId: '73000000-0000-4000-8000-000000000999' });
    };
    installFakeApi(routes as never);
    const ui = renderFieldUi(<MemoryRouter><BulkContinueDialog actorId={anna.id} workspaceId={alpha.id} tasks={tasks} currentProjectId={SOURCE} onClose={() => undefined} /></MemoryRouter>);
    await waitFor(() => expect(document.body.textContent).toContain('Week 2'));
    await ui.user.selectOptions(screen.getByLabelText('Continue in project'), OTHER);
    await ui.user.click(screen.getByRole('button', { name: 'Close and continue 3 tasks in Week 2' }));
    expect(await screen.findByText('2 of 3 tasks continued.')).toBeInTheDocument();
    expect(calls.map(call => call.id)).toEqual(tasks.map(task => task.id));
    expect(new Set(calls.map(call => call.key)).size).toBe(3);
    expect(calls[0]?.body).toEqual({ targetProjectId: OTHER, carryFieldIds: [] });
    secondFails = false;
    await ui.user.click(screen.getByRole('button', { name: 'Try the remaining 1 again' }));
    expect(await screen.findByText('3 of 3 tasks continued.')).toBeInTheDocument();
    expect(calls).toHaveLength(4);
  });
});
