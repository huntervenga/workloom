import type { CreateTaskInput, MembershipDto, TaskDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, created, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });

const annaMember = alphaMembers[0] as MembershipDto;
const otherMember = alphaMembers[2] as MembershipDto;
// The shared fixture task is already Anna's (MEMBER_ID is her membership).
const taskA: TaskDto = { ...task, title: 'Alpha row', position: 0, responsibleMembershipId: annaMember.id };
const taskB: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-0000000000b1', workPackageId: 'f1000000-0000-4000-8000-0000000000b1', title: 'Bravo row', position: 1, responsibleMembershipId: annaMember.id };
const taskC: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-0000000000c1', workPackageId: 'f1000000-0000-4000-8000-0000000000c1', title: 'Charlie row', position: 2, responsibleMembershipId: annaMember.id };
const NEW_ID = 'f2000000-0000-4000-8000-0000000000d1';
const builtin = (key: string) => ({ column: { kind: 'builtin', key }, visible: true });
const preference = (keys: string[]) => ({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: annaMember.id, revision: 1, columns: keys.map(builtin) });
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'placement-edges-fixture', nextCursor: null } });
type Calls = ReturnType<typeof installFakeApi>['calls'];
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const posts = (calls: Calls) => calls.filter(call => call.method === 'POST');
const patches = (calls: Calls) => calls.filter(call => call.method === 'PATCH');
const listReads = (calls: Calls) => calls.filter(call => call.method === 'GET' && call.path === `${rootPath}/tasks`);
const rowOf = (node: HTMLElement) => node.closest('tr') as HTMLTableRowElement;
const titleRow = (title: string) => rowOf(screen.getByRole('button', { name: title }));
/** The unsaved draft is the only open task name editor once the source title editor closes. */
const draftInput = () => screen.getByRole('textbox', { name: 'Task name' }) as HTMLInputElement;
/** Real rows by task ID and draft rows by state, in document order. */
const order = () => [...document.querySelectorAll('tr[data-task-row], tr[data-task-draft-row]')]
  .map(item => item.getAttribute('data-task-row') ?? `draft:${item.getAttribute('data-task-draft-state') ?? ''}`);
const reposition = (rows: TaskDto[]) => rows.map((item, position) => ({ ...item, position }));

function routes(rows: () => TaskDto[], columns: string[], extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => page(rows()),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference(columns)),
    ...extra,
  };
}

async function enterOnUnchangedTitle(user: ReturnType<typeof renderApp>['user'], title: string) {
  await user.click(await screen.findByRole('button', { name: title }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Task name' })).toHaveValue(title));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(draftInput()).toHaveFocus());
  expect(draftInput()).toHaveValue('');
}

describe('an Open filter refetch that drops the anchor while an unsent draft follows it', () => {
  it('keeps the same focused input in its original gap after A and before C, sends nothing and leaves no ghost on Escape', async () => {
    // The authoritative open-only list; B later becomes done elsewhere, never through this test.
    let served: TaskDto[] = [taskA, taskB, taskC];
    const { calls } = installFakeApi(routes(() => served, ['title', 'status']));
    const { queryClient, user } = renderApp(`${tablePath}?completion=open`);

    await enterOnUnchangedTitle(user, taskB.title);
    // The URL filter really reached the list request.
    expect(listReads(calls).at(-1)?.searchParams.get('completion')).toBe('open');
    expect(order()).toEqual([taskA.id, taskB.id, 'draft:draft', taskC.id]);
    await user.keyboard('Unsent draft');
    const input = draftInput();
    input.setSelectionRange(2, 7);
    expect(input).toHaveFocus();
    const readsBefore = listReads(calls).length;

    // A head refresh: the next authoritative open list no longer contains B.
    served = reposition([taskA, taskC]);
    await act(async () => {
      await queryClient.invalidateQueries({ predicate: query => query.queryKey[4] === 'tasks' && query.queryKey[5] === 'list' && query.queryKey[6] === PROJECT_ID });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: taskB.title })).not.toBeInTheDocument());
    expect(listReads(calls).length).toBeGreaterThan(readsBefore);
    expect(listReads(calls).at(-1)?.searchParams.get('completion')).toBe('open');

    // The very same input keeps its text, focus and selection, still between A and C, not after C.
    expect(input.isConnected).toBe(true);
    expect(draftInput()).toBe(input);
    expect(input).toHaveValue('Unsent draft');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
    expect(order()).toEqual([taskA.id, 'draft:draft', taskC.id]);
    const draftRow = rowOf(input);
    expect(titleRow(taskA.title).nextElementSibling).toBe(draftRow);
    expect(draftRow.nextElementSibling).toBe(titleRow(taskC.title));
    expect(posts(calls)).toHaveLength(0);
    expect(patches(calls)).toHaveLength(0);

    // Escape drops the never-sent draft: no write, no ghost row, nothing on screen.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue('Unsent draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsent draft' })).not.toBeInTheDocument();
    expect(order()).toEqual([taskA.id, taskC.id]);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('plain Enter on an unchanged middle task title grouped by assignee', () => {
  const otherTask: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-0000000000e1', workPackageId: 'f1000000-0000-4000-8000-0000000000e1', title: 'Other person row', position: 3, responsibleMembershipId: otherMember.id };
  const annaGroup = `Collapse assignee group “${annaMember.displayName}”`;
  const otherGroup = `Collapse assignee group “${otherMember.displayName}”`;

  it('opens a full row right after B inside Anna’s group and creates Anna’s task anchored on B', async () => {
    let stored: TaskDto[] = [taskA, taskB, taskC, otherTask];
    const { calls } = installFakeApi(routes(() => stored, ['title', 'status', 'responsible'], {
      // The server stores exactly the sent responsible person, right after the sent anchor.
      [`POST ${rootPath}/tasks`]: request => {
        const body = request.body as CreateTaskInput;
        const row: TaskDto = { ...task, id: NEW_ID, workPackageId: 'f1000000-0000-4000-8000-0000000000d1', title: body.title, statusId: body.statusId, responsibleMembershipId: body.responsibleMembershipId ?? null };
        const at = stored.findIndex(item => item.id === body.insertion?.anchorTaskId);
        stored = reposition(at < 0 ? [...stored, row] : [...stored.slice(0, at + 1), row, ...stored.slice(at + 1)]);
        return created(stored.find(item => item.id === NEW_ID));
      },
    }));
    const { user } = renderApp(tablePath);

    // Grouping is page state chosen through the normal Group by control, not a URL key.
    await screen.findByRole('button', { name: taskB.title });
    const grouping = screen.getByRole('combobox', { name: 'Group by' });
    await user.click(grouping);
    await user.click(within(screen.getByRole('listbox', { name: 'Group by' })).getByRole('option', { name: 'Assignee' }));
    await screen.findByRole('button', { name: annaGroup });
    expect(screen.getByRole('button', { name: otherGroup })).toBeInTheDocument();
    const annaBody = titleRow(taskB.title).closest('tbody') as HTMLTableSectionElement;
    expect(within(annaBody).getByRole('button', { name: annaGroup })).toBeInTheDocument();
    expect(titleRow(otherTask.title).closest('tbody')).not.toBe(annaBody);

    await enterOnUnchangedTitle(user, taskB.title);
    const bRow = titleRow(taskB.title);
    const draftRow = rowOf(draftInput());
    // A normal full row of Anna's group, directly between B and C.
    expect(draftRow).not.toBe(bRow);
    expect(bRow.nextElementSibling).toBe(draftRow);
    expect(draftRow.nextElementSibling).toBe(titleRow(taskC.title));
    expect(draftRow.closest('tbody')).toBe(annaBody);
    expect(draftRow.cells.length).toBeGreaterThan(1);
    expect(draftRow.cells).toHaveLength(bRow.cells.length);
    // The containing group's person is the draft's default responsible, without any assignee filter.
    expect(draftRow).toHaveTextContent(annaMember.displayName);
    expect(writes(calls)).toHaveLength(0);

    await user.keyboard('Anna next{Enter}');
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    const body = posts(calls)[0]?.body as CreateTaskInput;
    expect(body).toMatchObject({ projectId: PROJECT_ID, title: 'Anna next', responsibleMembershipId: annaMember.id, statusId: taskB.statusId });
    expect(body.insertion).toEqual({ anchorTaskId: taskB.id, placement: 'after' });
    expect(body).not.toHaveProperty('position');
    // No invented participants or time values.
    expect(body.participantMembershipIds ?? []).toEqual([]);
    expect(body).not.toHaveProperty('estimateMinutes');

    // The authoritative list keeps the new task in Anna's group after B; no Unassigned jump.
    const savedRow = rowOf(await screen.findByRole('button', { name: 'Anna next' }));
    await waitFor(() => expect(titleRow(taskB.title).nextElementSibling).toBe(titleRow('Anna next')));
    expect(titleRow('Anna next').closest('tbody')).toBe(titleRow(taskB.title).closest('tbody'));
    expect(within(savedRow.closest('tbody') as HTMLTableSectionElement).getByRole('button', { name: annaGroup })).toBeInTheDocument();
    // Unassigned stays an intentional empty, expanded drop target: the new task never jumps into it.
    const unassignedBody = document.querySelector('tbody[data-task-assignee-group=""]') as HTMLTableSectionElement;
    expect(within(unassignedBody).getByRole('button', { name: 'Collapse assignee group “Unassigned”' })).toHaveAttribute('aria-expanded', 'true');
    expect(unassignedBody.querySelector('th[scope="rowgroup"] .sr-only')).toHaveTextContent('0 tasks');
    expect(unassignedBody.querySelector('tr[data-task-group-drop=""]')).toBeInTheDocument();
    expect(unassignedBody.querySelectorAll('tr[data-task-row]')).toHaveLength(0);
    expect(unassignedBody.querySelector(`tr[data-task-row="${NEW_ID}"]`)).toBeNull();
    expect(within(unassignedBody).queryByRole('button', { name: 'Anna next' })).not.toBeInTheDocument();
    expect(stored.find(item => item.id === NEW_ID)).toMatchObject({ responsibleMembershipId: annaMember.id });
    expect(posts(calls)).toHaveLength(1);
    expect(patches(calls)).toHaveLength(0);
  });

  // No subtask case: assignee grouping lists every task flat under its own responsible person
  // (taskGrouping.ts never builds a parent tree there), so a child has no containing parent group.
});

describe('Escape on the bottom section draft', () => {
  // Only the never-sent buffer: submitted or unknown creates keep their own queue and recovery.
  it('cancels typed unsent text without a create, and reopens empty', async () => {
    const { calls } = installFakeApi(routes(() => [taskA, taskB, taskC], ['title', 'status']));
    const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: taskC.title });
    const addRow = () => document.querySelector<HTMLButtonElement>('button[data-add-task-row=""]') as HTMLButtonElement;

    await user.click(addRow());
    await waitFor(() => expect(draftInput()).toHaveFocus());
    expect(order()).toEqual([taskA.id, taskB.id, taskC.id, 'draft:draft']);
    expect(rowOf(draftInput()).cells).toHaveLength(titleRow(taskC.title).cells.length);
    await user.keyboard('Never sent');
    expect(draftInput()).toHaveValue('Never sent');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue('Never sent')).not.toBeInTheDocument();
    expect(order()).toEqual([taskA.id, taskB.id, taskC.id]);
    expect(posts(calls)).toHaveLength(0);

    // Reopening starts from an empty buffer; the cancelled text is gone for good.
    await user.click(addRow());
    await waitFor(() => expect(draftInput()).toHaveFocus());
    expect(draftInput()).toHaveValue('');
    expect(screen.queryByDisplayValue('Never sent')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    expect(writes(calls)).toHaveLength(0);
  });
});
