import { chooseTimeContext, timeContextLabel } from '../features/work-categories/test/timeContext';
import type { SectionDto, TaskDto, TaskFieldValueDto } from '@workloom/contracts';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, anna, created, deferred, failure, installFakeApi, json, ok, project, renderApp, type RouteTable } from '../test/fakeApi';
import { queryKeys } from '../lib/queryKeys';
import { commitment, lostResponse } from '../features/planning/test/fixtures';
import { field } from '../features/fields/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, categorized, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const SECTION_A = 'e1000000-0000-4000-8000-000000000001';
const SECTION_B = 'e1000000-0000-4000-8000-000000000002';
const NEXT_STATUS = 'f6000000-0000-4000-8000-000000000002';
const sections: SectionDto[] = [
  { id: SECTION_A, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'First section', position: 0, revision: 1, archivedAt: null },
  { id: SECTION_B, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Second section', position: 1, revision: 1, archivedAt: null },
];
const parent = { ...task, title: 'Root in first', sectionId: SECTION_A, estimateMinutes: 120 };
// Its own section differs, but this child is displayed under the first section's root.
const child = { ...parent, id: 'f2000000-0000-4000-8000-000000000002', title: 'Child from second', parentTaskId: parent.id, sectionId: SECTION_B };
const other = { ...task, id: 'f2000000-0000-4000-8000-000000000003', title: 'Root in second', sectionId: SECTION_B, workPackageId: 'f1000000-0000-4000-8000-000000000003', estimateMinutes: 60 };
const loose = { ...task, id: 'f2000000-0000-4000-8000-000000000004', title: 'Unsectioned root', workPackageId: 'f1000000-0000-4000-8000-000000000004', estimateMinutes: 30 };
const page = (rows: TaskDto[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'section-fixture', nextCursor } });
function routes(extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => page([parent, child, other, loose]),
    [`GET ${rootPath}/tasks/${parent.id}`]: () => ok(parent),
    [`GET ${rootPath}/tasks/${child.id}`]: () => ok(child),
    [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(sections),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([
      { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
      { id: NEXT_STATUS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
    ]),
    ...extra,
  };
}
function views() { return within(screen.getByRole('navigation', { name: 'Project views' })); }
function quickForm() { return within(screen.getByRole('form', { name: 'Add a task to First section' })); }
const collapse = (name = 'First section') => screen.getByRole('button', { name: `Collapse section “${name}”` });
const expand = (name = 'First section') => screen.getByRole('button', { name: `Expand section “${name}”` });
function unloadPrevented() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
function writes(calls: ReturnType<typeof installFakeApi>['calls']) { return calls.filter(call => call.method !== 'GET'); }

describe('page-owned section collapse', () => {
  it('retains Graph selection, loaded counts and totals across Board, filters and additional pages', async () => {
    const extra = { ...other, id: 'f2000000-0000-4000-8000-000000000005', title: 'Later first-section task', sectionId: SECTION_A, workPackageId: 'f1000000-0000-4000-8000-000000000005', estimateMinutes: 45 };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => request.searchParams.has('search') ? page([other]) : request.searchParams.has('cursor') ? page([extra]) : page([parent, child, other, loose], 'next-section-page') }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('checkbox', { name: `Select for graph: ${parent.title}` }));
    await user.click(collapse());
    expect(screen.queryByRole('button', { name: parent.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: child.title })).not.toBeInTheDocument();
    expect(expand().closest('th')).toHaveTextContent('loaded: 2 tasks');
    expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('3h 30m');
    await user.click(views().getByRole('button', { name: 'Board' }));
    await screen.findByRole('button', { name: child.title });
    await user.click(views().getByRole('button', { name: 'Tasks' }));
    expect(expand()).toHaveAttribute('aria-expanded', 'false');
    await user.type(screen.getByLabelText('Search tasks'), 'second only');
    await waitFor(() => expect(expand().closest('th')).toHaveTextContent('loaded: 0 tasks'));
    await user.clear(screen.getByLabelText('Search tasks'));
    await waitFor(() => expect(expand().closest('th')).toHaveTextContent('loaded: 2 tasks'));
    await user.click(screen.getByRole('button', { name: 'Load more tasks' }));
    await waitFor(() => expect(expand().closest('th')).toHaveTextContent('3 tasks'));
    expect(screen.queryByRole('button', { name: extra.title })).not.toBeInTheDocument();
    expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('4h 15m');
    await user.click(expand());
    expect(screen.getByRole('checkbox', { name: `Select for graph: ${parent.title}` })).toBeChecked();
    expect(screen.getByRole('button', { name: extra.title })).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it('uses stable group keys when a section is renamed or reordered and resets on a fresh project-page mount', async () => {
    let currentSections = sections;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(currentSections) }));
    const ui = renderApp(tablePath);
    await screen.findByRole('button', { name: parent.title }); await ui.user.click(collapse());
    currentSections = sections.map(section => section.id === SECTION_A ? { ...section, name: 'Renamed section', position: 9, revision: 2 } : section);
    await act(async () => { await ui.queryClient.invalidateQueries({ queryKey: queryKeys.sections(anna.id, alpha.id, PROJECT_ID), exact: true }); });
    expect(await screen.findByRole('button', { name: 'Expand section “Renamed section”' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: parent.title })).not.toBeInTheDocument();
    ui.unmount();
    renderApp(tablePath);
    await screen.findByRole('button', { name: parent.title }); expect(collapse('Renamed section')).toHaveAttribute('aria-expanded', 'true');
    expect(writes(calls)).toHaveLength(0);
  });

  it('commits a dirty cross-section title before collapse and retains its held command through the drawer', async () => {
    const gate = deferred<Response>();
    let current = child;
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([parent, current, other, loose]),
      [`GET ${rootPath}/tasks/${child.id}`]: () => ok(current),
      [`PATCH ${rootPath}/tasks/${child.id}`]: () => gate.promise,
    }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: child.title }));
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Autosaved child rename' } });
    await user.click(collapse());
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: child.revision, title: 'Autosaved child rename' });
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    expect(unloadPrevented()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    const drawer = within(await screen.findByRole('dialog'));
    expect(drawer.getByLabelText('Task name')).toHaveValue('Autosaved child rename');
    expect(drawer.getByLabelText('Task name')).toBeDisabled();
    await act(async () => gate.resolve(ok(current = { ...child, title: 'Autosaved child rename', revision: child.revision + 1 })));
    await waitFor(() => expect(unloadPrevented()).toBe(false));
    expect(writes(calls)).toHaveLength(1);
  });

  it('retains an unknown inline command through section collapse and retries the original revision/key', async () => {
    const first = lostResponse(); let attempts = 0; let current = child;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([parent, current, other]), [`PATCH ${rootPath}/tasks/${child.id}`]: () => ++attempts === 1 ? first.promise : ok(current = { ...child, statusId: NEXT_STATUS, revision: 2 }) }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Edit status for ${child.title}` }));
    await user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Stored progress' }));
    await waitFor(() => expect(attempts).toBe(1)); await user.click(collapse());
    await act(async () => first.lose()); await screen.findByRole('button', { name: 'Resume original editor' });
    await user.click(views().getByRole('button', { name: 'Board' }));
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Stored progress');
    expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument();
    await user.click(views().getByRole('button', { name: 'Tasks' }));
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(within(drawer).getByRole('combobox', { name: 'Status' })).toHaveTextContent('Stored progress');
    await user.click(within(drawer).getByRole('button', { name: 'Retry submission' }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(within(drawer).queryByRole('button', { name: 'Retry submission' })).not.toBeInTheDocument());
    const sent = writes(calls); expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toEqual({ expectedRevision: child.revision, statusId: NEXT_STATUS });
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });

  it('expands the retained quick-add target rather than the different clicked section and keeps its unknown command exact', async () => {
    const first = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi(routes({ [`POST ${rootPath}/tasks`]: () => ++attempts === 1 ? first.promise : created({ ...parent, title: 'Original first-section draft' }) }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
    await user.type(screen.getByLabelText('Task name'), 'Original first-section draft');
    await user.click(quickForm().getByRole('button', { name: 'Add task' })); await waitFor(() => expect(attempts).toBe(1));
    await user.type(screen.getByLabelText('Task name'), 'Next unsent title');
    await user.click(collapse()); await user.click(collapse('Second section'));
    await act(async () => first.lose()); await screen.findByRole('button', { name: 'Resume original editor' });
    await user.click(screen.getByRole('button', { name: 'Add task to “Second section”' }));
    expect(collapse()).toHaveAttribute('aria-expanded', 'true'); expect(expand('Second section')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Task name')).toHaveValue('Next unsent title'); expect(screen.getByLabelText('Task name')).not.toHaveAttribute('readonly');
    expect(screen.getByText('Submitted task: Original first-section draft')).toBeInTheDocument();
    await user.click(collapse()); await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    expect(collapse()).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    await waitFor(() => expect(screen.getByLabelText('Task name')).toHaveValue('Next unsent title'));
    const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[0]?.body).toMatchObject({ sectionId: SECTION_A, title: 'Original first-section draft' });
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });

  it('reopens rejected quick-queue recovery after collapse so the rejected original can be discarded explicitly', async () => {
    let attempts = 0;
    const { calls } = installFakeApi(routes({ [`POST ${rootPath}/tasks`]: request => ++attempts === 1 ? failure(409, 'REVISION_CONFLICT', 'private') : created({ ...parent, ...(request.body as object) }) }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
    await user.type(screen.getByLabelText('Task name'), 'Rejected task{Enter}Replacement draft');
    await screen.findByRole('button', { name: 'Discard rejected task' });
    await user.click(screen.getByRole('button', { name: 'Collapse editor' }));
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task name')).toHaveValue('Replacement draft');
    await user.click(screen.getByRole('button', { name: 'Discard rejected task' }));
    await user.click(screen.getByLabelText('Task name')); await user.keyboard('{Enter}');
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION_A, title: 'Replacement draft', statusId: parent.statusId });
  });

  it.each(['untouched', 'confirmed'] as const)('uses the newly opened section after an earlier %s blank quick row', async previous => {
    const { calls } = installFakeApi(routes({ [`POST ${rootPath}/tasks`]: request => created({ ...parent, ...(request.body as object) }) }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
    if (previous === 'confirmed') {
      await user.type(screen.getByLabelText('Task name'), 'First completed create{Enter}');
      await waitFor(() => expect(writes(calls)).toHaveLength(1));
      await waitFor(() => expect(unloadPrevented()).toBe(false));
    }
    await user.click(screen.getByRole('button', { name: 'Collapse editor' }));
    await user.click(screen.getByRole('button', { name: 'Add task to “Second section”' }));
    const row = within(screen.getByRole('form', { name: 'Add a task to Second section' }));
    expect(row.getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    await user.type(row.getByRole('textbox', { name: 'Task name' }), 'Task for second section{Enter}');
    await waitFor(() => expect(writes(calls)).toHaveLength(previous === 'confirmed' ? 2 : 1));
    expect(writes(calls).at(-1)?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION_B, title: 'Task for second section', statusId: parent.statusId });
  });

  it.each(['inline', 'quick'] as const)('does not reopen or steal focus after a hidden pending %s acknowledgement', async kind => {
    const gate = deferred<Response>(); let current = child;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([parent, current, other]), [`PATCH ${rootPath}/tasks/${child.id}`]: () => gate.promise, [`POST ${rootPath}/tasks`]: () => gate.promise }));
    const { user } = renderApp(tablePath);
    if (kind === 'inline') {
      await user.click(await screen.findByRole('button', { name: child.title }));
      fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Confirmed hidden title' } });
      await user.keyboard('{Control>}{Enter}{/Control}');
    } else {
      await user.click(await screen.findByRole('button', { name: 'Add task to “First section”' }));
      await user.type(screen.getByLabelText('Task name'), 'Confirmed hidden title'); await user.click(quickForm().getByRole('button', { name: 'Add task' }));
    }
    await waitFor(() => expect(writes(calls)).toHaveLength(1)); await user.click(collapse());
    expect(expand()).toHaveFocus(); await screen.findByRole('button', { name: 'Resume original editor' });
    current = { ...child, title: 'Confirmed hidden title', revision: 2 };
    await act(async () => gate.resolve(kind === 'quick' ? created({ ...parent, title: 'Confirmed hidden title' }) : ok(current)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument());
    expect(expand()).toHaveFocus(); expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(expand()); expect(screen.getByLabelText('Task name')).toHaveValue(kind === 'quick' ? '' : 'Confirmed hidden title');
    if (kind === 'quick') await user.click(quickForm().getByRole('button', { name: 'Add task' }));
    else { await user.click(screen.getByLabelText('Task name')); await user.keyboard('{Control>}{Enter}{/Control}'); }
    expect(writes(calls)).toHaveLength(1);
  });

  it('lets viewers collapse sections while keeping task mutations unavailable', async () => {
    const { calls } = installFakeApi(routes({ 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) }));
    const { user } = renderApp(tablePath); await screen.findByRole('button', { name: parent.title });
    await user.click(collapse()); expect(expand()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Add task to “First section”' })).not.toBeInTheDocument();
    await user.click(expand()); expect(screen.queryByRole('button', { name: `Rename ${parent.title}` })).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });
});


it('does not leak the shared No section disclosure state into another project', async () => {
  const otherProject = 'e0000000-0000-4000-8000-000000000009';
  const otherPath = `/w/${alpha.id}/projects/${otherProject}`;
  const otherRow = { ...loose, projectId: otherProject };
  installFakeApi(routes({
    [`GET ${rootPath}/projects/${otherProject}`]: () => ok(project(alpha.id, otherProject, 'Other project')),
    [`GET ${rootPath}/projects/${otherProject}/sections`]: () => ok([]),
    [`GET ${rootPath}/projects/${otherProject}/statuses`]: () => ok([]),
    [`GET ${rootPath}/tasks`]: request => page(request.searchParams.get('projectId') === otherProject ? [otherRow] : [parent, child, loose]),
  }));
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><AppRoutes /></SessionProvider> }], { initialEntries: [tablePath] });
  const ui = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  try {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: 'Collapse section “No section”' }));
    expect(screen.queryByRole('button', { name: loose.title })).not.toBeInTheDocument();
    await act(async () => { await router.navigate(otherPath); });
    await screen.findByRole('heading', { name: 'Other project' });
    await screen.findByRole('button', { name: loose.title });
    expect(screen.getByRole('button', { name: 'Collapse section “No section”' })).toHaveAttribute('aria-expanded', 'true');
  } finally { ui.unmount(); router.dispose(); client.clear(); }
});


async function closeDialog(user: ReturnType<typeof renderApp>['user'], title: string) {
  const dialog = screen.getByRole('dialog', { name: title });
  await user.click(within(dialog).getByLabelText('Close', { selector: 'button' }));
}

it.each(['plan', 'fact'] as const)('preserves an ordinary %s hours draft and its unknown original save while its section is collapsed', async kind => {
  const first = lostResponse(); let attempts = 0;
  const savePath = kind === 'plan' ? `POST ${rootPath}/periods/${PERIOD_A}/commitments` : `PUT ${rootPath}/tasks/${parent.id}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`;
  const { calls } = installFakeApi(routes({ [savePath]: () => ++attempts === 1 ? first.promise : kind === 'plan' ? created(commitment(150)) : ok(categorized(150)) }));
  const { user } = renderApp(tablePath);
  await chooseTimeContext(user, 'Week for hours', PERIOD_A);
  const action = kind === 'plan' ? `Weekly plan: ${parent.title}` : `Weekly actual hours: ${parent.title}`;
  const title = kind === 'plan' ? 'Add to weekly plan' : 'Record weekly actual hours';
  const input = kind === 'plan' ? 'Planned hours' : 'Actual hours this week';
  await user.click(await screen.findByRole('button', { name: action }));
  let dialog = await screen.findByRole('dialog', { name: title });
  await user.clear(within(dialog).getByLabelText(input)); await user.type(within(dialog).getByLabelText(input), '2.5');
  await closeDialog(user, title); await user.click(collapse());
  expect(unloadPrevented()).toBe(true); expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
  await user.click(expand()); await user.click(screen.getByRole('button', { name: action }));
  dialog = await screen.findByRole('dialog', { name: title }); expect(within(dialog).getByLabelText(input)).toHaveValue('2.5');
  await user.click(within(dialog).getByRole('button', { name: kind === 'plan' ? 'Save personal plan' : 'Save actual hours' }));
  await waitFor(() => expect(attempts).toBe(1)); await closeDialog(user, title); await user.click(collapse());
  await act(async () => first.lose()); await user.click(await screen.findByRole('button', { name: 'Open original hours save' }));
  dialog = await screen.findByRole('dialog', { name: title }); expect(within(dialog).getByLabelText(input)).toHaveValue('2:30');
  expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A)); expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', MEMBER_ID));
  await user.click(within(dialog).getByRole('button', { name: 'Retry original save' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument());
  const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[1]?.path).toBe(sent[0]?.path);
  expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  expect(expand()).toHaveAttribute('aria-expanded', 'false');
});

it.each([false, true])('keeps the drawer-owned custom value draft outside section row lifetime (submitted: %s)', async submitted => {
  const note = field('Section note'); const first = lostResponse(); let attempts = 0;
  let values: TaskFieldValueDto[] = [];
  const { calls } = installFakeApi(routes({
    [`GET ${rootPath}/fields`]: () => ok([note]),
    [`GET ${rootPath}/tasks/${parent.id}/field-values`]: () => ok(values),
    [`PUT ${rootPath}/tasks/${parent.id}/field-values/${note.id}`]: () => {
      if (++attempts === 1) return first.promise;
      const result = { workspaceId: alpha.id, projectId: PROJECT_ID, taskId: parent.id, fieldId: note.id, definitionVersionId: note.definitionVersionId, revision: 1, value: { type: 'text' as const, value: 'Retained custom value' }, updatedAt: parent.updatedAt };
      values = [result]; return ok(result);
    },
  }));
  const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: `Open task “${parent.title}”` }));
  await user.click(await screen.findByRole('button', { name: 'Edit “Section note”' }));
  let valueDialog = await screen.findByRole('dialog', { name: 'Value of “Section note”' });
  await user.type(within(valueDialog).getByRole('textbox', { name: 'Section note' }), 'Retained custom value');
  if (submitted) {
    await user.click(within(valueDialog).getByRole('button', { name: 'Save value' }));
    await waitFor(() => expect(attempts).toBe(1));
  }
  await closeDialog(user, 'Value of “Section note”'); await closeDialog(user, parent.title); await user.click(collapse());
  if (submitted) {
    await act(async () => first.lose()); await user.click(await screen.findByRole('button', { name: 'Open submission' }));
  } else {
    await user.click(expand()); await user.click(screen.getByRole('button', { name: `Open task “${parent.title}”` }));
  }
  await user.click(await screen.findByRole('button', { name: 'Edit “Section note”' }));
  valueDialog = await screen.findByRole('dialog', { name: 'Value of “Section note”' });
  expect(within(valueDialog).getByRole('textbox', { name: 'Section note' })).toHaveValue('Retained custom value');
  if (submitted) {
    expect(within(valueDialog).getByRole('textbox', { name: 'Section note' })).toBeDisabled();
    await user.click(within(valueDialog).getByRole('button', { name: 'Retry submission' }));
    await waitFor(() => expect(attempts).toBe(2));
    const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  } else expect(writes(calls)).toHaveLength(0);
});
