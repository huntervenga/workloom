import type { SectionDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, created, deferred, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, tablePath, tableRoutes, task } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const section: SectionDto = { id: 'e1000000-0000-4000-8000-000000000001', workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Existing section', position: 0, revision: 1, archivedAt: null };
const next: SectionDto = { ...section, id: 'e1000000-0000-4000-8000-000000000002', name: 'New heading', position: 1 };
const sectionPath = `${rootPath}/projects/${PROJECT_ID}/sections`;
function routes(rows = [section], extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: request => json(200, { data: request.searchParams.has('search') ? [] : [{ ...task, sectionId: section.id, title: 'Existing task' }], meta: { requestId: 'sections', nextCursor: null } }), [`GET ${sectionPath}`]: () => ok(rows), ...extra };
}
async function addSection(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'More add options' }));
  await user.click(within(screen.getByRole('menu', { name: 'Add to project' })).getByRole('menuitem', { name: 'Add section' }));
  return screen.getByRole('textbox', { name: 'Section name' });
}
async function grouping(user: ReturnType<typeof renderApp>['user'], name: 'Section' | 'Assignee') {
  await user.click(screen.getByRole('combobox', { name: 'Group by' }));
  await user.click(within(screen.getByRole('listbox', { name: 'Group by' })).getByRole('option', { name }));
}
const sent = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');

describe('inline section creation and visible section context', () => {
  it('opens a focused inline title from the Add task dropdown, submits once on Enter and keeps the empty header', async () => {
    const rows = [section];
    const { calls } = installFakeApi(routes(rows, { [`POST ${sectionPath}`]: () => { rows.push(next); return created(next); } }));
    const { user } = renderApp(tablePath);
    const title = await addSection(user);
    expect(title).toHaveFocus(); expect(screen.queryByRole('dialog', { name: 'New section' })).not.toBeInTheDocument();
    await user.type(title, '  New heading  '); await user.keyboard('{Enter}');
    const header = await screen.findByRole('button', { name: 'Collapse section “New heading”' });
    expect(header).toBeVisible(); expect(screen.queryByRole('textbox', { name: 'Section name' })).not.toBeInTheDocument();
    expect(sent(calls)).toHaveLength(1); expect(sent(calls)[0]?.path).toBe(sectionPath); expect(sent(calls)[0]?.body).toEqual({ name: 'New heading' });
    expect(sent(calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    await user.click(header); expect(screen.getByRole('button', { name: 'Expand section “New heading”' })).toBeVisible();
    await user.type(screen.getByLabelText('Search tasks'), 'no matching task');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Existing task' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Expand section “New heading”' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Collapse section “Existing section”' })).toBeVisible();
  });

  it('explains Assignee grouping and restores sections without writes; Add section also returns to Sections', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: 'Collapse section “Existing section”' });
    await grouping(user, 'Assignee');
    expect(screen.queryByRole('button', { name: 'Collapse section “Existing section”' })).not.toBeInTheDocument();
    expect(screen.getByText('Grouped by assignee. Your sections are still available.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show sections' }));
    expect(screen.getByRole('button', { name: 'Collapse section “Existing section”' })).toBeVisible();
    await grouping(user, 'Assignee'); const title = await addSection(user);
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveTextContent('Section'); expect(title).toHaveFocus();
    expect(sent(calls)).toHaveLength(0);
  });

  it('Escape discards an unsent name and restores focus without creating a section', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    const title = await addSection(user); await user.type(title, 'Unsent heading'); await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Section name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More add options' })).toHaveFocus();
    expect(await addSection(user)).toHaveValue(''); expect(sent(calls)).toHaveLength(0);
  });

  it('retains an unsent title through another view and resumes it without another command', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.type(await addSection(user), 'Kept heading');
    await user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Board' }));
    await user.click(screen.getByRole('button', { name: 'Resume section' }));
    expect(screen.getByRole('textbox', { name: 'Section name' })).toHaveValue('Kept heading'); expect(screen.getByRole('textbox', { name: 'Section name' })).toHaveFocus();
    expect(sent(calls)).toHaveLength(0);
  });

  it('does not steal Search focus when a refreshed filter remounts the retained section draft', async () => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi(routes([section], { [`GET ${rootPath}/tasks`]: request => request.searchParams.has('search') ? gate.promise : json(200, { data: [{ ...task, sectionId: section.id, title: 'Existing task' }], meta: { requestId: 'initial', nextCursor: null } }) }));
    const { user } = renderApp(tablePath); await user.type(await addSection(user), 'Kept heading');
    const search = screen.getByLabelText('Search tasks'); await user.type(search, 'filtered');
    await waitFor(() => expect(calls.some(call => call.path === `${rootPath}/tasks` && call.searchParams.get('search') === 'filtered')).toBe(true));
    expect(search).toHaveFocus();
    await act(async () => gate.resolve(json(200, { data: [], meta: { requestId: 'filtered', nextCursor: null } })));
    expect(await screen.findByRole('textbox', { name: 'Section name' })).toHaveValue('Kept heading');
    expect(search).toHaveFocus(); expect(sent(calls)).toHaveLength(0);
  });

  it('hands focus to the confirmed section only after its current section list arrives, exactly once', async () => {
    const ack = deferred<Response>(), refreshed = deferred<Response>(); let refresh = false;
    const { calls } = installFakeApi(routes([section], { [`GET ${sectionPath}`]: () => refresh ? refreshed.promise : ok([section]), [`POST ${sectionPath}`]: () => ack.promise }));
    const { user } = renderApp(tablePath); await user.type(await addSection(user), 'New heading'); await user.keyboard('{Enter}');
    await waitFor(() => expect(sent(calls)).toHaveLength(1)); refresh = true;
    await act(async () => ack.resolve(created(next)));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add section' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Collapse section “New heading”' })).not.toBeInTheDocument();
    await act(async () => refreshed.resolve(ok([section, next])));
    const header = await screen.findByRole('button', { name: 'Collapse section “New heading”' }); expect(header).toHaveFocus();
    await user.click(screen.getByLabelText('Search tasks')); expect(screen.getByLabelText('Search tasks')).toHaveFocus();
    expect(sent(calls)).toHaveLength(1);
  });

  it('keeps a second creation focused while its ACK is held, then reveals only its new header', async () => {
    const secondAck = deferred<Response>(), third = { ...next, id: 'e1000000-0000-4000-8000-000000000003', name: 'Second heading', position: 2 };
    const rows = [section]; let attempts = 0;
    const { calls } = installFakeApi(routes(rows, { [`POST ${sectionPath}`]: () => { attempts += 1; if (attempts === 1) { rows.push(next); return created(next); } return secondAck.promise; } }));
    const { user } = renderApp(tablePath); await user.type(await addSection(user), 'New heading'); await user.keyboard('{Enter}');
    const firstHeader = await screen.findByRole('button', { name: 'Collapse section “New heading”' }); expect(firstHeader).toHaveFocus();
    const title = await addSection(user); await user.type(title, 'Second heading'); await user.keyboard('{Enter}');
    await waitFor(() => expect(attempts).toBe(2)); expect(title).toHaveAttribute('readonly'); expect(title).toHaveFocus(); expect(firstHeader).not.toHaveFocus();
    rows.push(third); await act(async () => secondAck.resolve(created(third)));
    expect(await screen.findByRole('button', { name: 'Collapse section “Second heading”' })).toHaveFocus();
    expect(sent(calls)).toHaveLength(2); expect(sent(calls).map(call => call.body)).toEqual([{ name: 'New heading' }, { name: 'Second heading' }]);
  });

  it.each(['cancel', 'outside focus', 'another view'] as const)('does not reveal or refocus a created section after %s during its pending command', async departure => {
    const ack = deferred<Response>(); let confirmed = false;
    const { calls } = installFakeApi(routes([section], { [`GET ${sectionPath}`]: () => ok(confirmed ? [section, next] : [section]), [`POST ${sectionPath}`]: () => ack.promise }));
    const { user } = renderApp(tablePath); await user.type(await addSection(user), 'New heading'); await user.keyboard('{Enter}');
    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    if (departure === 'cancel') await user.keyboard('{Escape}');
    else if (departure === 'outside focus') await user.click(screen.getByLabelText('Search tasks'));
    else await user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Board' }));
    confirmed = true; await act(async () => ack.resolve(created(next)));
    if (departure === 'another view') {
      expect(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
      await user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Tasks' }));
    }
    const header = await screen.findByRole('button', { name: 'Collapse section “New heading”' }); expect(header).not.toHaveFocus();
    if (departure === 'outside focus') expect(screen.getByLabelText('Search tasks')).toHaveFocus();
    expect(sent(calls)).toHaveLength(1);
  });

  it('keeps a sent command locked after Escape and retries the exact original body/key after a lost reply', async () => {
    const first = lostResponse(); const rows = [section]; let attempts = 0;
    const { calls } = installFakeApi(routes(rows, { [`POST ${sectionPath}`]: () => { attempts += 1; if (attempts === 1) return first.promise; rows.push(next); return created(next); } }));
    const { user } = renderApp(tablePath); await user.type(await addSection(user), 'New heading'); await user.keyboard('{Enter}');
    await waitFor(() => expect(attempts).toBe(1)); expect(screen.getByRole('textbox', { name: 'Section name' })).toHaveAttribute('readonly');
    await user.keyboard('{Escape}'); await act(async () => first.lose());
    await user.click(screen.getByRole('button', { name: 'Resume section' }));
    expect(screen.getByRole('textbox', { name: 'Section name' })).toHaveValue('New heading');
    await user.click(within(screen.getByRole('form', { name: 'Add section' })).getByRole('button', { name: 'Retry submission' }));
    await screen.findByRole('button', { name: 'Collapse section “New heading”' });
    const writes = sent(calls); expect(writes).toHaveLength(2); expect(writes[0]?.body).toEqual({ name: 'New heading' }); expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('does not create while an IME composition confirms Enter, and does not duplicate a pending submission', async () => {
    const gate = deferred<Response>(); const { calls } = installFakeApi(routes([section], { [`POST ${sectionPath}`]: () => gate.promise })); const { user } = renderApp(tablePath);
    const title = await addSection(user); await user.type(title, 'Composed heading');
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true }); expect(sent(calls)).toHaveLength(0);
    await user.keyboard('{Enter}'); await waitFor(() => expect(sent(calls)).toHaveLength(1));
    fireEvent.submit(screen.getByRole('form', { name: 'Add section' })); expect(sent(calls)).toHaveLength(1);
    await act(async () => gate.resolve(created({ ...next, name: 'Composed heading' })));
  });

  it('keeps viewer sections and grouping available without creation controls', async () => {
    const { calls } = installFakeApi(routes([section], { 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) })); const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: 'Collapse section “Existing section”' }); expect(screen.queryByRole('button', { name: 'More add options' })).not.toBeInTheDocument();
    await grouping(user, 'Assignee'); await user.click(screen.getByRole('button', { name: 'Show sections' }));
    expect(screen.getByRole('button', { name: 'Collapse section “Existing section”' })).toBeVisible(); expect(sent(calls)).toHaveLength(0);
  });
});
