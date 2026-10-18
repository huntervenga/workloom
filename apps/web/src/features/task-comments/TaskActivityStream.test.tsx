import { safeProfilePhotoUrl, type TaskCommentDto, type TaskDto, type TaskTimelineItemDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, anna, created, deferred, failure, installFakeApi, json, type FakeRequest } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { MEMBER_ID, rootPath, task } from '../planning/test/fixtures';
import { TaskActivityStream } from './TaskActivityStream';
import { discussionKeys } from './queries';
import { useTaskCommentsWorkspace, type TaskCommentsWorkspace } from './useTaskCommentsWorkspace';

type ActivityRow = Extract<TaskTimelineItemDto, { type: 'activity' }>;
type CommentRow = Extract<TaskTimelineItemDto, { type: 'comment' }>;
const path = `${rootPath}/tasks/${task.id}`;
const timelinePath = `${path}/timeline`;
const commentsPath = `${path}/comments`;
const rowId = (n: number) => `f9100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number) => `2026-10-19T09:${String(n).padStart(2, '0')}:00.000Z`;
const photo = 'https://photos.example.com/anna.jpg';
// Sequences beyond Number.MAX_SAFE_INTEGER: 9007199254740992 and ...993 collapse to one double.
const SEQ = { oldest: '9007199254740992', tie: '9007199254740993', newer: '9007199254740994', newest: '9007199254740995' };

function commentRow(n: number, body: string, changeSeq: string, extra: Partial<TaskCommentDto> = {}): CommentRow {
  return { type: 'comment', id: rowId(n), workspaceId: alpha.id, taskId: task.id, changeSeq, eventOrdinal: 1, occurredAt: at(n),
    comment: { id: rowId(n + 500), workspaceId: alpha.id, taskId: task.id, authorUserId: anna.id, authorMembershipId: MEMBER_ID, authorDisplayNameSnapshot: 'Name when posted', authorAvatarUrl: null, createdAt: at(n), body, ...extra } };
}
function activityRow(n: number, changeSeq: string, eventOrdinal = 1, extra: Partial<ActivityRow> = {}): ActivityRow {
  return { type: 'activity', id: rowId(n), workspaceId: alpha.id, taskId: task.id, changeSeq, eventOrdinal, occurredAt: at(n), kind: 'updated', actorUserId: anna.id, actorMembershipId: MEMBER_ID, actorDisplayName: 'Current member name', actorAvatarUrl: null, detail: 'exact', changes: [{ field: 'title', from: `Title ${n - 1}`, to: `Title ${n}` }], ...extra };
}
const page = (rows: readonly TaskTimelineItemDto[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'timeline-qa', nextCursor } });
const timelineGets = (calls: readonly FakeRequest[]) => calls.filter(call => call.method === 'GET' && call.path === timelinePath);
const writes = (calls: readonly FakeRequest[]) => calls.filter(call => call.method !== 'GET');
const order = () => Array.from(document.querySelectorAll('[data-task-comment-id], [data-task-activity-id]'), element => element.getAttribute('data-task-comment-id') ?? element.getAttribute('data-task-activity-id'));
const entry = (id: string) => { const element = document.querySelector<HTMLElement>(`[data-task-comment-id="${id}"], [data-task-activity-id="${id}"]`); if (!element) throw new Error(`Missing entry ${id}`); return element; };
const following = (before: Node, after: Node) => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

function harness({ writable = true, initial = task }: { writable?: boolean; initial?: TaskDto } = {}) {
  let current: TaskCommentsWorkspace | null = null;
  let showTask: (next: TaskDto) => void = () => undefined;
  let setMounted: (next: boolean) => void = () => undefined;
  function Harness() {
    const controller = useTaskCommentsWorkspace(anna.id, alpha.id); current = controller;
    const [shown, setShown] = useState(initial); showTask = setShown;
    const [mounted, setMountedState] = useState(true); setMounted = setMountedState;
    return mounted ? <TaskActivityStream task={shown} controller={controller} writable={writable} canRetry timezone={alpha.timezone} onOpenTask={vi.fn()} /> : null;
  }
  return { ...renderFieldUi(<Harness />),
    controller: () => { if (!current) throw new Error('Missing controller'); return current; },
    showTask: (next: TaskDto) => act(() => showTask(next)),
    mount: (next: boolean) => act(() => setMounted(next)) };
}
const confirmed = (revision = task.revision + 1): TaskDto => ({ ...task, revision });

describe('task activity stream', () => {
  it('renders one combined timeline request chronologically, ordering unsafe-integer sequences and ordinal ties exactly', async () => {
    const newest = commentRow(5, 'Newest comment', SEQ.newest);
    const rows = [newest, activityRow(4, SEQ.newer), activityRow(3, SEQ.tie, 2), activityRow(2, SEQ.tie, 1), activityRow(1, SEQ.oldest)];
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page(rows) });
    harness();
    await screen.findByText('Newest comment');
    expect(order()).toEqual([rowId(1), rowId(2), rowId(3), rowId(4), newest.comment.id]);
    expect(calls).toHaveLength(1); expect(calls[0]?.path).toBe(timelinePath);
    expect(calls[0]?.searchParams.get('limit')).toBe('50'); expect(calls[0]?.searchParams.has('cursor')).toBe(false);
    expect(screen.getByText('Start of this task’s history.')).toBeVisible();
  });

  it('shows only the loading status before the first page, never the empty state', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`GET ${timelinePath}`]: () => response.promise });
    harness();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading activity…');
    expect(screen.queryByText('No comments or changes yet.')).not.toBeInTheDocument();
    await act(async () => response.resolve(page([])));
    await screen.findByText('No comments or changes yet.');
    expect(screen.queryByText('Loading activity…')).not.toBeInTheDocument();
  });

  it('loads older history from the top control with one cursor request and deduplicates overlapping rows', async () => {
    const newest = commentRow(3, 'Latest body', SEQ.newest); const overlap = activityRow(2, SEQ.newer); const oldest = activityRow(1, SEQ.oldest);
    const older = deferred<Response>();
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: request => request.searchParams.has('cursor') ? older.promise : page([newest, overlap], 'opaque-cursor-1') });
    const ui = harness();
    await screen.findByText('Latest body');
    expect(screen.getByText('Showing the latest 2 entries. Older history loads 50 at a time.')).toBeVisible();
    const button = screen.getByRole('button', { name: 'Load 50 older' });
    expect(following(button, screen.getByRole('list', { name: 'Activity' }))).toBe(true);
    await ui.user.click(button);
    await ui.user.click(screen.getByRole('button', { name: 'Loading older…' }));
    await act(async () => older.resolve(page([overlap, oldest])));
    await screen.findByText('Start of this task’s history.');
    expect(order()).toEqual([rowId(1), rowId(2), newest.comment.id]);
    const gets = timelineGets(calls); expect(gets).toHaveLength(2);
    expect(gets[1]?.searchParams.get('cursor')).toBe('opaque-cursor-1'); expect(gets[1]?.searchParams.get('limit')).toBe('50');
    expect(calls).toHaveLength(2);
  });

  it('keeps the composer after every entry and posts exact plaintext through the comment mutation only', async () => {
    let stored: TaskTimelineItemDto[] = [activityRow(1, SEQ.oldest)];
    const body = '  <b>raw</b>\n[link](https://example.test)  ';
    const { calls } = installFakeApi({
      [`GET ${timelinePath}`]: () => page(stored),
      [`POST ${commentsPath}`]: request => { const row = commentRow(2, (request.body as { body: string }).body, SEQ.newer); stored = [row, ...stored]; return created(row.comment); },
    });
    const ui = harness();
    await waitFor(() => expect(order()).toEqual([rowId(1)]));
    const composer = screen.getByLabelText('Comment');
    expect(following(screen.getByRole('list', { name: 'Activity' }), composer)).toBe(true);
    fireEvent.change(composer, { target: { value: body } });
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    await screen.findByText('Comment posted.');
    await waitFor(() => expect(order()).toEqual([rowId(1), rowId(502)]));
    expect(entry(rowId(502)).querySelector('p')?.textContent).toBe(body);
    expect(document.querySelector('b')).toBeNull(); expect(document.querySelector('a[href="https://example.test"]')).toBeNull();
    expect(screen.getByLabelText('Comment')).toHaveValue('');
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]?.path).toBe(commentsPath); expect(writes(calls)[0]?.body).toEqual({ body });
    expect(timelineGets(calls)).toHaveLength(2);
  });

  it('retains an unknown 503 comment through remount and retries the same bytes and Idempotency-Key', async () => {
    let attempt = 0;
    const { calls } = installFakeApi({
      [`GET ${timelinePath}`]: () => page([]),
      [`POST ${commentsPath}`]: request => ++attempt === 1 ? failure(503, 'UNAVAILABLE', 'private 503 details') : created(commentRow(1, (request.body as { body: string }).body, SEQ.newer).comment),
    });
    const ui = harness();
    await screen.findByText('No comments or changes yet.');
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: '  Exact\r\ntext  ' } });
    const original = (screen.getByLabelText('Comment') as HTMLTextAreaElement).value;
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    await screen.findByRole('button', { name: 'Retry original comment' });
    expect(screen.queryByText('private 503 details')).not.toBeInTheDocument();
    ui.mount(false); ui.mount(true);
    expect(await screen.findByLabelText('Comment')).toBeDisabled(); expect(screen.getByLabelText('Comment')).toHaveValue(original);
    await ui.user.click(screen.getByRole('button', { name: 'Retry original comment' }));
    await screen.findByText('Comment posted.');
    const posts = writes(calls); expect(posts).toHaveLength(2);
    expect(posts.every(call => call.method === 'POST' && call.path === commentsPath)).toBe(true);
    expect(posts[0]?.body).toEqual({ body: original }); expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(posts[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(posts[1]?.headers.get('Idempotency-Key')).toBe(posts[0]?.headers.get('Idempotency-Key'));
    expect(ui.controller().drafts[task.id]).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeVisible();
  });

  it.each([401, 403])('hides the cached feed after a current %s and shows known rows again after an explicit refresh', async status => {
    let denied = false;
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => denied ? failure(status, status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', 'private denial details') : page([commentRow(1, 'Known cached body', SEQ.newer)]) });
    const ui = harness();
    await screen.findByText('Known cached body');
    denied = true;
    await act(async () => { await ui.client.invalidateQueries({ queryKey: discussionKeys.timeline(anna.id, alpha.id, task.id), exact: true }); });
    await waitFor(() => expect(screen.queryByText('Known cached body')).not.toBeInTheDocument());
    expect(order()).toEqual([]); expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument();
    expect(screen.queryByText('private denial details')).not.toBeInTheDocument();
    denied = false;
    await ui.user.click(screen.getByRole('button', { name: 'Refresh discussion' }));
    await screen.findByText('Known cached body');
    expect(screen.getByLabelText('Comment')).toBeEnabled();
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps known rows when an older page answers 503 and retries the same cursor', async () => {
    let olderAttempt = 0;
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: request => !request.searchParams.has('cursor') ? page([commentRow(2, 'Known latest', SEQ.newer)], 'opaque-cursor-2')
      : ++olderAttempt === 1 ? failure(503, 'UNAVAILABLE', 'private older details') : page([activityRow(1, SEQ.oldest)]) });
    const ui = harness();
    await screen.findByText('Known latest');
    await ui.user.click(screen.getByRole('button', { name: 'Load 50 older' }));
    await screen.findByText('Older history couldn’t be loaded. The entries already shown are kept.');
    expect(screen.getByText('Known latest')).toBeVisible(); expect(screen.queryByText('private older details')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(order()).toEqual([rowId(1), rowId(502)]));
    expect(screen.queryByText('Older history couldn’t be loaded. The entries already shown are kept.')).not.toBeInTheDocument();
    const cursors = timelineGets(calls).map(call => call.searchParams.get('cursor')); expect(cursors).toEqual([null, 'opaque-cursor-2', 'opaque-cursor-2']);
  });

  it('labels opted-out and uncaptured custom history without fetching or showing current values', async () => {
    const custom = activityRow(1, SEQ.newer, 1, { kind: 'field_value', detail: 'partial', changes: [
      { field: 'custom', fieldId: rowId(900), fieldName: 'Secret budget', fieldType: null, availability: 'opted_out' },
      { field: 'custom', fieldId: rowId(901), fieldName: 'Legacy note', fieldType: null, availability: 'uncaptured' },
    ] });
    const blank = activityRow(2, SEQ.newest, 1, { detail: 'uncaptured', changes: [] });
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page([blank, custom]), [`GET ${path}/field-values`]: () => json(200, { data: 'SECRET-CURRENT-VALUE', meta: { requestId: 'secret' } }) });
    harness();
    await screen.findByText('Current member name changed a custom field');
    const row = within(entry(rowId(1)));
    expect(row.getByText('Secret budget:')).toBeVisible(); expect(row.getByText('History is turned off for this field; values aren’t shown')).toBeVisible();
    expect(row.getByText('Legacy note:')).toBeVisible(); expect(row.getByText('Values weren’t recorded')).toBeVisible();
    expect(row.getByText('Some details of this change weren’t recorded.')).toBeVisible();
    expect(within(entry(rowId(2))).getByText('Details of this change weren’t recorded.')).toBeVisible();
    expect(screen.queryByText(/SECRET-CURRENT-VALUE/)).not.toBeInTheDocument();
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([`GET ${timelinePath}`]);
  });

  it('shows the current public photo or initials beside each visible name', async () => {
    expect(safeProfilePhotoUrl(photo)).toBe(photo);
    const posted = commentRow(2, 'Photo comment', SEQ.newest, { authorAvatarUrl: photo });
    installFakeApi({ [`GET ${timelinePath}`]: () => page([posted, activityRow(1, SEQ.newer)]) });
    harness();
    await screen.findByText('Photo comment');
    const image = entry(posted.comment.id).querySelector('img');
    expect(image).toHaveAttribute('src', photo); expect(image).toHaveAttribute('alt', ''); expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(within(entry(posted.comment.id)).getByText('Name when posted')).toBeVisible();
    expect(entry(rowId(1)).querySelector('img')).toBeNull();
    expect(within(entry(rowId(1))).getByText('Current member name changed this task')).toBeVisible();
    if (image) fireEvent.error(image);
    expect(entry(posted.comment.id).querySelector('img')).toBeNull();
  });

  it('requests a new timeline automatically after its own task revision is confirmed, without manual refresh', async () => {
    let rows: TaskTimelineItemDto[] = [commentRow(1, 'Before revision', SEQ.oldest)];
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page(rows) });
    const ui = harness();
    await screen.findByText('Before revision');
    ui.showTask({ ...task }); expect(timelineGets(calls)).toHaveLength(1);
    rows = [activityRow(2, SEQ.newer), ...rows];
    ui.showTask(confirmed());
    await waitFor(() => expect(order()).toEqual([rowId(501), rowId(2)]));
    expect(timelineGets(calls)).toHaveLength(2); expect(writes(calls)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Refresh discussion' })).not.toBeInTheDocument();
  });

  it('fetches fresh history when the revision is confirmed while the initial timeline request is still held', async () => {
    const held = deferred<Response>(); let gets = 0;
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => ++gets === 1 ? held.promise : page([activityRow(2, SEQ.newer), commentRow(1, 'Stale body', SEQ.oldest)]) });
    const ui = harness();
    await waitFor(() => expect(timelineGets(calls)).toHaveLength(1));
    ui.showTask(confirmed());
    await act(async () => held.resolve(page([commentRow(1, 'Stale body', SEQ.oldest)])));
    await waitFor(() => expect(timelineGets(calls)).toHaveLength(2));
    await waitFor(() => expect(order()).toEqual([rowId(501), rowId(2)]));
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps comment focus and draft when new history arrives after an acknowledged revision', async () => {
    let rows: TaskTimelineItemDto[] = [activityRow(1, SEQ.oldest)];
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page(rows) });
    const ui = harness();
    await waitFor(() => expect(order()).toEqual([rowId(1)]));
    await ui.user.click(screen.getByLabelText('Comment')); await ui.user.type(screen.getByLabelText('Comment'), 'Draft in progress');
    rows = [activityRow(2, SEQ.newer), ...rows];
    ui.showTask(confirmed());
    await waitFor(() => expect(order()).toEqual([rowId(1), rowId(2)]));
    expect(screen.getByLabelText('Comment')).toHaveFocus(); expect(screen.getByLabelText('Comment')).toHaveValue('Draft in progress');
    expect(ui.controller().drafts[task.id]?.body).toBe('Draft in progress');
    expect(writes(calls)).toHaveLength(0);
  });

  it('refreshes after a comment ACK while the initial timeline read is held, without a task revision bump', async () => {
    const held = deferred<Response>(); let gets = 0;
    const posted = commentRow(2, 'Acknowledged during first read', SEQ.newer);
    const { calls } = installFakeApi({
      [`GET ${timelinePath}`]: () => ++gets === 1 ? held.promise : page([posted]),
      [`POST ${commentsPath}`]: () => created(posted.comment),
    });
    const ui = harness();
    await waitFor(() => expect(timelineGets(calls)).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: posted.comment.body } });
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    await screen.findByText('Comment posted.');
    await act(async () => held.resolve(page([])));
    await waitFor(() => expect(order()).toEqual([posted.comment.id]));
    expect(timelineGets(calls)).toHaveLength(2);
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]?.body).toEqual({ body: posted.comment.body });
    expect(screen.getByLabelText('Comment')).toHaveValue('');
  });

  it('holds one pending comment and ignores repeated submits', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page([]), [`POST ${commentsPath}`]: () => response.promise });
    const ui = harness();
    await screen.findByText('No comments or changes yet.');
    await ui.user.type(screen.getByLabelText('Comment'), 'Only once');
    await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
    const posting = await screen.findByRole('button', { name: 'Posting…' });
    expect(posting).toHaveAttribute('aria-disabled', 'true'); expect(screen.getByLabelText('Comment')).toBeDisabled();
    await ui.user.click(posting);
    expect(writes(calls)).toHaveLength(1);
    await act(async () => response.resolve(created(commentRow(1, 'Only once', SEQ.newer).comment)));
    await screen.findByText('Comment posted.');
    expect(writes(calls)).toHaveLength(1);
  });

  it.each([
    ['read-only access', false, task, 'You can read this discussion. Commenting is unavailable with your current access.'],
    ['an archived task', true, { ...task, archivedAt: '2026-10-19T12:00:00.000Z' }, 'This task is archived. Existing discussion is read-only.'],
  ] as const)('shows rows without a composer for %s', async (_case, writable, initial, message) => {
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page([commentRow(1, 'Readable body', SEQ.newer)]) });
    harness({ writable, initial });
    await screen.findByText('Readable body');
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Add comment' })).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });
});
