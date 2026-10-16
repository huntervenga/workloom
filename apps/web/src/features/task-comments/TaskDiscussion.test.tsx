import type { TaskCommentDto, TaskActivityDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, json, ok, project, type RouteTable } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, MEMBER_ID, rootPath, task } from '../planning/test/fixtures';
import { TaskDiscussion } from './TaskDiscussion';
import { TaskDrawer } from '../tasks/TaskDrawer';
import { useTaskCommands } from '../tasks/useTaskCommands';
import { CommentCommandRecovery } from './CommentCommandRecovery';
import { fetchComments } from './api';
import { discussionKeys } from './queries';
import { commentProblem, useTaskCommentsWorkspace, type TaskCommentsWorkspace } from './useTaskCommentsWorkspace';

const path = `${rootPath}/tasks/${task.id}`;
const secondTask = 'f2000000-0000-4000-8000-000000000002';
const comment: TaskCommentDto = { id: 'f9000000-0000-4000-8000-000000000001', workspaceId: alpha.id, taskId: task.id, authorUserId: anna.id, authorMembershipId: MEMBER_ID, authorDisplayNameSnapshot: 'Name when posted', createdAt: '2026-10-19T09:10:00.000Z', body: 'Saved body' };
const event: TaskActivityDto = { id: 'f9000000-0000-4000-8000-000000000002', workspaceId: alpha.id, taskId: task.id, actorUserId: anna.id, actorMembershipId: MEMBER_ID, actorDisplayName: 'Current member name', occurredAt: '2026-10-19T09:00:00.000Z', kind: 'created', changeSeq: '9007199254740993', eventOrdinal: 1 };
const page = (rows: unknown[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'comments-qa', nextCursor } });
function routes(extra: RouteTable = {}): RouteTable {
  return { [`GET ${path}`]: () => ok(task), [`GET ${path}/comments`]: () => page([]), [`GET ${path}/activity`]: () => page([]), ...extra };
}
function example({ viewer = false }: { viewer?: boolean } = {}) {
  let current: TaskCommentsWorkspace | null = null;
  function Example() {
    const controller = useTaskCommentsWorkspace(anna.id, alpha.id); current = controller;
    const commands = useTaskCommands(anna.id, alpha.id);
    const [open, setOpen] = useState(true);
    return <><CommentCommandRecovery controller={controller} visibleTaskId={open ? task.id : null} onOpen={() => setOpen(true)} />{open ? <TaskDrawer actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Stored project')} sections={[]} statuses={[]} members={alphaMembers} tags={[]} writable={!viewer} commands={commands} commentsController={controller} taskId={task.id} creating={null} onClose={() => setOpen(false)} onOpenTask={vi.fn()} onResumeCreate={vi.fn()} onCreated={vi.fn()} onAnnounce={vi.fn()} /> : null}<button onClick={() => setOpen(true)}>Reopen QA task</button><button>Outside QA focus</button></>;
  }
  return { ...renderFieldUi(<Example />), controller: () => { if (!current) throw new Error('Missing controller'); return current; } };
}
async function discussion(ui: ReturnType<typeof example>) {
  await ui.user.click(await screen.findByRole('tab', { name: /^Discussion/ }));
  await screen.findByText('No comments yet.');
}

describe('saved task discussion', () => {
  it('keeps field drafts in a sibling form and posts exact inert plaintext without changing task revision', async () => {
    let stored: TaskCommentDto[] = [];
    const { calls } = installFakeApi(routes({ [`GET ${path}/comments`]: () => page(stored), [`POST ${path}/comments`]: request => { stored = [{ ...comment, body: (request.body as { body: string }).body }]; return created(stored[0]); } }));
    const ui = example();
    const title = await screen.findByLabelText('Task name');
    await ui.user.clear(title); await ui.user.type(title, 'Unsaved field title');
    await ui.user.click(screen.getByText('More details', { selector: 'summary' }));
    await ui.user.clear(screen.getByLabelText('Team estimate, hours')); await ui.user.type(screen.getByLabelText('Team estimate, hours'), 'invalid');
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('Team estimate, hours')).toHaveAttribute('aria-invalid', 'true');
    await discussion(ui);
    expect(document.querySelector('form form')).toBeNull();
    const body = '  <img src=x onerror=alert(1)>\n[link](https://example.test)  ';
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: body } });
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    await screen.findByText('Comment posted.');
    expect(screen.getByLabelText('Comment')).toHaveValue('');
    expect(screen.getByText(content => content.includes('<img src=x onerror=alert(1)>')).textContent).toBe(body);
    expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('a[href="https://example.test"]')).toBeNull();
    const writes = calls.filter(call => call.method !== 'GET');
    expect(writes).toHaveLength(1); expect(writes[0]?.path).toBe(`${path}/comments`); expect(writes[0]?.body).toEqual({ body });
    await ui.user.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByLabelText('Task name')).toHaveValue('Unsaved field title');
    expect(screen.getByLabelText('Team estimate, hours')).toHaveValue('invalid');
    expect(screen.getByLabelText('Team estimate, hours')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter hours, such as 1.5 or 1:30.')).toBeVisible();
  });

  it('reconciles the exact pending composer after close/reopen without duplicates or clearing another task draft', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi(routes({ [`POST ${path}/comments`]: () => response.promise }));
    const ui = example(); await discussion(ui);
    await ui.user.type(screen.getByLabelText('Comment'), 'Sent original');
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(ui.controller().command.pendingCommand).not.toBeNull());
    act(() => ui.controller().setBody(secondTask, 'Independent draft'));
    await ui.user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent('still being posted');
    await ui.user.click(screen.getByRole('button', { name: 'Open discussion' }));
    expect(await screen.findByLabelText('Comment')).toHaveValue('Sent original'); expect(screen.getByLabelText('Comment')).toBeDisabled();
    await ui.user.click(screen.getByRole('tab', { name: /^Discussion/ }));
    const focused = document.activeElement;
    await act(async () => response.resolve(created({ ...comment, body: 'Sent original' })));
    await screen.findByText('Comment posted.');
    expect(screen.getByLabelText('Comment')).toHaveValue(''); expect(document.activeElement).toBe(focused);
    expect(ui.controller().drafts[secondTask]?.body).toBe('Independent draft');
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('keeps an unknown body locked through remount and retries with the same bytes and idempotency key', async () => {
    let lose: () => void = () => undefined; let attempt = 0;
    const lost = new Promise<Response>((_resolve, reject) => { lose = () => reject(new TypeError('Failed to fetch')); });
    const { calls } = installFakeApi(routes({ [`POST ${path}/comments`]: request => ++attempt === 1 ? lost : created({ ...comment, body: (request.body as { body: string }).body }) }));
    const ui = example(); await discussion(ui);
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: '  Exact\r\ntext  ' } });
    const original = (screen.getByLabelText('Comment') as HTMLTextAreaElement).value;
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(attempt).toBe(1)); await act(async () => lose());
    await screen.findByRole('button', { name: 'Retry original comment' }); await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Open discussion' }));
    expect(await screen.findByLabelText('Comment')).toBeDisabled(); expect(screen.getByLabelText('Comment')).toHaveValue(original);
    await ui.user.click(screen.getByRole('button', { name: 'Retry original comment' }));
    await screen.findByText('Comment posted.');
    const writes = calls.filter(call => call.method === 'POST'); expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual({ body: original }); expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(ui.controller().drafts[task.id]).toBeUndefined();
  });

  it('deduplicates comment pages and immediately hides cached feed after current page access is denied', async () => {
    let denied = false;
    installFakeApi(routes({ [`GET ${path}/comments`]: request => request.searchParams.has('cursor') ? denied ? failure(403, 'FORBIDDEN', 'sensitive denied body') : page([comment, { ...comment, id: 'f9000000-0000-4000-8000-000000000003', body: 'Older body' }]) : page([comment], 'opaque-next') }));
    const ui = example();
    await ui.user.click(await screen.findByRole('tab', { name: 'Discussion' }));
    await screen.findByText('Saved body'); await ui.user.click(screen.getByRole('button', { name: 'Load older comments' }));
    await screen.findByText('Older body'); expect(screen.getAllByText('Saved body')).toHaveLength(1);
    denied = true;
    await act(async () => { await ui.client.invalidateQueries({ queryKey: discussionKeys.comments(anna.id, alpha.id, task.id), exact: true }); });
    await waitFor(() => expect(screen.queryByText('Saved body')).not.toBeInTheDocument());
    expect(screen.queryByText('Older body')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();
    expect(screen.queryByText('sensitive denied body')).not.toBeInTheDocument();
  });

  it('lets viewers read distinct comment snapshot and current activity author labels without a composer', async () => {
    const { calls } = installFakeApi(routes({ [`GET ${path}/comments`]: () => page([comment]), [`GET ${path}/activity`]: () => page([event]) }));
    const ui = example({ viewer: true }); await ui.user.click(await screen.findByRole('tab', { name: 'Discussion' }));
    await screen.findByText('Name when posted'); expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();
    await ui.user.click(screen.getByText('Activity', { selector: 'summary' }));
    await screen.findByText('Current member name created this task.');
    expect(screen.getByText('Name when posted')).toBeVisible();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps Enter as a newline and uses explicit Ctrl+Enter to post', async () => {
    const { calls } = installFakeApi(routes({ [`POST ${path}/comments`]: request => created({ ...comment, body: (request.body as { body: string }).body }) }));
    const ui = example(); await discussion(ui);
    await ui.user.type(screen.getByLabelText('Comment'), 'Line one{Enter}Line two');
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await ui.user.keyboard('{Control>}{Enter}{/Control}'); await screen.findByText('Comment posted.');
    expect(calls.filter(call => call.method === 'POST')[0]?.body).toEqual({ body: 'Line one\nLine two' });
  });
});

it('validates the bounded exact plaintext without normalizing valid input', () => {
  expect(commentProblem('  ')).toBe('blank'); expect(commentProblem('a'.repeat(4001))).toBe('tooLong');
  expect(commentProblem('a\0b')).toBe('nul'); expect(commentProblem('  valid\r\nbody  ')).toBeNull();
});

it.each([401, 403, 404])('hides cached discussion after a current comment-post denial (%s) while retaining the unsent session', async status => {
  const { calls } = installFakeApi(routes({ [`GET ${path}/comments`]: () => page([comment]), [`POST ${path}/comments`]: () => failure(status, status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', 'private server details') }));
  const ui = example(); await ui.user.click(await screen.findByRole('tab', { name: 'Discussion' }));
  await screen.findByText('Saved body');
  await ui.user.type(screen.getByLabelText('Comment'), 'Retained denied draft');
  await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
  await waitFor(() => expect(screen.queryByText('Saved body')).not.toBeInTheDocument());
  expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();
  expect(screen.queryByText('private server details')).not.toBeInTheDocument();
  expect(ui.controller().drafts[task.id]?.body).toBe('Retained denied draft');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
});

it('allows an explicit exact unknown retry after archive without enabling a fresh archived comment', async () => {
  let fail: () => void = () => undefined; let attempt = 0;
  const first = new Promise<Response>((_resolve, reject) => { fail = () => reject(new TypeError('Failed to fetch')); });
  const { calls } = installFakeApi(routes({ [`POST ${path}/comments`]: request => ++attempt === 1 ? first : created({ ...comment, body: (request.body as { body: string }).body }) }));
  let archive: () => void = () => undefined;
  function Example() {
    const controller = useTaskCommentsWorkspace(anna.id, alpha.id);
    const [archived, setArchived] = useState(false); archive = () => setArchived(true);
    return <TaskDiscussion task={archived ? { ...task, archivedAt: '2026-10-19T12:00:00.000Z' } : task} controller={controller} writable={!archived} canRetry timezone={alpha.timezone} active onOpenTask={vi.fn()} />;
  }
  const ui = renderFieldUi(<Example />);
  await ui.user.type(screen.getByLabelText('Comment'), 'Original before archive');
  await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
  await waitFor(() => expect(attempt).toBe(1)); await act(async () => fail());
  await screen.findByRole('button', { name: 'Retry original comment' }); act(() => archive());
  expect(screen.getByLabelText('Comment')).toBeDisabled();
  await ui.user.click(screen.getByRole('button', { name: 'Retry original comment' })); await screen.findByText('Comment posted.');
  expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();
  expect(screen.getByText('This task is archived. Existing discussion is read-only.')).toBeVisible();
  const posts = calls.filter(call => call.method === 'POST'); expect(posts).toHaveLength(2);
  expect(posts[0]?.body).toEqual(posts[1]?.body); expect(posts[0]?.headers.get('Idempotency-Key')).toBe(posts[1]?.headers.get('Idempotency-Key'));
});

it('scopes discussion caches to actor, workspace and canonical task identity', () => {
  expect(discussionKeys.comments(anna.id, alpha.id, task.id.toUpperCase())).toEqual(discussionKeys.comments(anna.id, alpha.id, task.id));
  expect(discussionKeys.comments('other-actor', alpha.id, task.id)).not.toEqual(discussionKeys.comments(anna.id, alpha.id, task.id));
  expect(discussionKeys.activity(anna.id, alpha.id, task.id)).not.toEqual(discussionKeys.comments(anna.id, alpha.id, task.id));
});

it.each(['wrong-task', 'missing-cursor'])('rejects an unsafe timeline response (%s)', async kind => {
  installFakeApi(routes({ [`GET ${path}/comments`]: () => kind === 'wrong-task' ? page([{ ...comment, taskId: secondTask }]) : ok([comment]) }));
  await expect(fetchComments(alpha.id, task.id, null)).rejects.toMatchObject({ kind: 'invalid_response' });
});

it('confirms a closed composer without reopening a drawer, changing its selected pane or taking focus', async () => {
  const response = deferred<Response>();
  installFakeApi(routes({ [`POST ${path}/comments`]: () => response.promise }));
  const ui = example(); await discussion(ui);
  await ui.user.type(screen.getByLabelText('Comment'), 'Late closed post');
  await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
  await waitFor(() => expect(ui.controller().command.pendingCommand).not.toBeNull());
  await ui.user.keyboard('{Escape}');
  act(() => ui.controller().setTab(task.id, 'details'));
  await ui.user.click(screen.getByRole('button', { name: 'Outside QA focus' }));
  await act(async () => response.resolve(created({ ...comment, body: 'Late closed post' })));
  await waitFor(() => expect(ui.controller().command.pendingCommand).toBeNull());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Outside QA focus' })).toHaveFocus();
  expect(ui.controller().tabs[task.id]).toBe('details');
  expect(ui.controller().drafts[task.id]).toBeUndefined();
});
