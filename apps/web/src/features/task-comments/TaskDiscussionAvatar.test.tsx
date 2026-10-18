import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, json } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { MEMBER_ID, rootPath, STAMP, task } from '../planning/test/fixtures';
import { TaskDiscussion } from './TaskDiscussion';
import { useTaskCommentsWorkspace } from './useTaskCommentsWorkspace';

function Example() {
  const controller = useTaskCommentsWorkspace(anna.id, alpha.id);
  return <TaskDiscussion task={task} controller={controller} writable={false} canRetry={false} timezone="UTC" active onOpenTask={() => undefined} />;
}
describe('legacy meeting discussion current author photo', () => {
  it('keeps the immutable author label/body beside a safe current photo and falls back after image failure', async () => {
    const commentId = 'f9900000-0000-4000-8000-000000000001', photo = 'https://photos.example.com/author.png';
    const { calls } = installFakeApi({
      [`GET ${rootPath}/tasks/${task.id}/comments`]: () => json(200, { data: [{ id: commentId, workspaceId: alpha.id, taskId: task.id, authorUserId: anna.id, authorMembershipId: MEMBER_ID, authorDisplayNameSnapshot: 'Historical Author', authorAvatarUrl: photo, createdAt: STAMP, body: 'Legacy meeting comment' }], meta: { requestId: 'photo', nextCursor: null } }),
      [`GET ${rootPath}/tasks/${task.id}/activity`]: () => json(200, { data: [], meta: { requestId: 'photo', nextCursor: null } }),
    });
    renderFieldUi(<Example />);
    await screen.findByText('Legacy meeting comment');
    const row = document.querySelector(`[data-task-comment-id="${commentId}"]`), image = row?.querySelector('img');
    expect(row).toHaveTextContent('Historical Author'); expect(image).toHaveAttribute('src', photo); expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    if (!image) throw new Error('Expected safe photo.'); fireEvent.error(image);
    expect(row?.querySelector('img')).toBeNull(); expect(row).toHaveTextContent('HA'); expect(row).toHaveTextContent('Legacy meeting comment');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
});
