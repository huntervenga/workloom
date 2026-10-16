import type { TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, deferred, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { field, STAMP } from '../features/fields/test/fixtures';
import { MEMBER_ID, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const DESIGN = '91000000-0000-4000-8000-000000000001';
const REVIEW = '91000000-0000-4000-8000-000000000002';
const stage: TaskFieldDefinitionDto = {
  ...field('QA stage', 'single_select'), workspaceId: alpha.id, projectId: PROJECT_ID, revision: 4,
  options: [
    { id: DESIGN, name: 'Design', color: '#6366f1', position: 1, revision: 1, archivedAt: null },
    { id: REVIEW, name: 'Review', color: '#0d9488', position: 2, revision: 1, archivedAt: null },
  ],
};
const valuePath = `${rootPath}/tasks/${task.id}/field-values/${stage.id}`;
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'inline-field-fixture', nextCursor: null } });
const stored = (revision: number, value: string): TaskFieldValueDto => ({ workspaceId: alpha.id, projectId: PROJECT_ID, taskId: task.id, fieldId: stage.id, definitionVersionId: stage.definitionVersionId, revision, value: { type: 'single_select', value }, updatedAt: STAMP });
function routes(extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => page([task]),
    [`GET ${rootPath}/fields`]: () => ok([stage]),
    [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: stage.id, position: 0, width: 160, visible: true }] }),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision: 0, columns: null }),
    [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([]),
    ...extra,
  };
}
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');

describe('project table custom choice cells', () => {
  it('saves one explicit stable option ID from the fixed cell without a drawer, page notice or extra Save', async () => {
    const gate = deferred<Response>(); let values: TaskFieldValueDto[] = [];
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok(values),
      [`PUT ${valuePath}`]: () => gate.promise,
    }));
    const { user } = renderApp(tablePath);
    const trigger = await screen.findByRole('combobox', { name: `Edit QA stage for ${task.title}` });
    expect(trigger.closest('td')).not.toBeNull(); expect(screen.getByRole('table').querySelector('select')).toBeNull();
    await user.click(trigger);
    const list = screen.getByRole('listbox', { name: `Edit QA stage for ${task.title}` });
    expect(list.closest('table')).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
    await user.click(trigger);
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Review' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: 0, expectedDefinitionRevision: 4, value: { type: 'single_select', value: REVIEW } });
    // The cell shows its own spinner; no page-level notice is inserted above the grid while it is sent.
    expect(screen.queryByText('A task field value is being submitted', { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    values = [stored(1, REVIEW)];
    await act(async () => gate.resolve(ok(stored(1, REVIEW))));
    await waitFor(() => expect(screen.getByRole('combobox', { name: `Edit QA stage for ${task.title}` })).toHaveTextContent('Review'));
    expect(writes(calls)).toHaveLength(1);
  });

  it.each(['viewer', 'archived'] as const)('keeps a %s custom choice read-only in the table', async kind => {
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([stored(2, DESIGN)]),
      ...(kind === 'viewer' ? { 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) } : { [`GET ${rootPath}/tasks`]: () => page([{ ...task, archivedAt: task.createdAt }]) }),
    }));
    renderApp(tablePath);
    await screen.findByRole('columnheader', { name: 'QA stage' });
    await screen.findByText('Design');
    expect(screen.queryByRole('combobox', { name: `Edit QA stage for ${task.title}` })).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });
});
