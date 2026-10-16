import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { MEMBER_ID, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const base: TaskDto = { ...task, title: 'Dismissal source task', priority: 'medium', revision: 7 };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'dismissal-fixture', nextCursor: null } });
const preferences = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'priority' }, visible: true }] };
function routes(): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preferences), [`GET ${rootPath}/tasks`]: () => page([base]), [`GET ${rootPath}/tasks/${base.id}`]: () => ok(base) };
}
const cell = () => screen.findByRole('button', { name: `Edit priority for ${base.title}` });
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

describe('project inline picker dismissal', () => {
  it('leaves focus where an outside press put it, while keyboard Escape still returns to the cell', async () => {
    const { calls } = installFakeApi(routes());
    const { user } = renderApp(tablePath);
    await user.click(await cell());
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveFocus();
    // Native order: the list closes on pointerdown, before the press moves focus anywhere.
    fireEvent.pointerDown(screen.getByRole('heading', { level: 1 }));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument());
    await act(async () => { await frame(); await frame(); });
    expect(await cell()).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);

    await user.click(await cell());
    await user.keyboard('{Escape}');
    await waitFor(async () => expect(await cell()).toHaveFocus());
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
