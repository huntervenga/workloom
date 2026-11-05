import { screen, waitFor, within } from '@testing-library/react';
import type { InboxItemDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, json, renderApp, singleActorRoutes } from '../../test/fakeApi';

const path = `/api/v1/workspaces/${alpha.id}/inbox`;
const id = (n: number) => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, kind: 'assigned' | 'comment', at: string, excerpt: string | null = null): InboxItemDto => ({ id: id(n), kind, at, actorName: 'Boris', excerpt, task: { id: id(n + 50), title: `Task ${n}`, projectId: id(99), projectName: 'Billing' }, leave: null });
const page = (items: InboxItemDto[]) => json(200, { data: items, meta: { requestId: 'inbox-test' } });

describe('inbox', () => {
  it('lists assignments and comments, marks what is new, and clears the sidebar badge once seen', async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const older = new Date(Date.now() - 3 * 86_400_000).toISOString();
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([item(1, 'comment', recent, 'Please check the invoice'), item(2, 'assigned', older)]) });
    const { user } = renderApp(`/w/${alpha.id}`);
    expect(await screen.findByLabelText('1 new in your inbox')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Inbox/ }));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(await screen.findByText('Boris commented on “Task 1”')).toBeInTheDocument();
    expect(screen.getByText('Please check the invoice')).toBeInTheDocument();
    expect(screen.getByText('Boris assigned you “Task 2”')).toBeInTheDocument();
    // Only the recent one carries the New mark while the page is open, and the badge is gone.
    expect(screen.getAllByText('New')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByLabelText('1 new in your inbox')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Boris commented/ }).getAttribute('href')).toContain(`/projects/${id(99)}?task=${id(51)}`);
  });

  it('shows time-off decisions and, for approvers, the requests waiting for them, linking to Time off', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const leave = (n: number, kind: 'leave_decided' | 'leave_pending', status: 'approved' | 'rejected' | 'pending'): InboxItemDto => ({ id: id(n), kind, at, actorName: 'Carla', excerpt: null, task: null, leave: { requestId: id(n + 70), status, startDate: '2026-11-02', endDate: '2026-11-06', personName: 'Dmitri' } });
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([leave(1, 'leave_decided', 'approved'), leave(2, 'leave_decided', 'rejected'), leave(3, 'leave_pending', 'pending')]) });
    const { user } = renderApp(`/w/${alpha.id}`);
    await user.click(await screen.findByRole('link', { name: /Inbox/ }));
    expect(await screen.findByText('Carla approved your time off (2026-11-02 – 2026-11-06)')).toBeInTheDocument();
    expect(screen.getByText('Carla declined your time off (2026-11-02 – 2026-11-06)')).toBeInTheDocument();
    expect(screen.getByText('Dmitri is waiting for your decision on time off (2026-11-02 – 2026-11-06)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dmitri is waiting/ }).getAttribute('href')).toContain('/time-off');
  });

  it('says so when nothing happened', async () => {
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([]) });
    const { user } = renderApp(`/w/${alpha.id}`);
    await user.click(await screen.findByRole('link', { name: /Inbox/ }));
    expect(await screen.findByText('Nothing new')).toBeInTheDocument();
  });
});

it('saves, marks unread, archives and restores an individual event', async () => {
  const event = { ...item(28, 'assigned', new Date(Date.now() - 3 * 86_400_000).toISOString()), kind: 'date_changed' as const };
  installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([event]) });
  const { user } = renderApp(`/w/${alpha.id}/inbox`);
  const link = await screen.findByRole('link', { name: /changed the due date for “Task 28”/ });
  const itemRow = link.closest('li');
  if (!itemRow) throw new Error('Missing inbox item');
  await user.click(within(itemRow).getByRole('button', { name: 'Save for later' }));
  await user.click(screen.getByRole('button', { name: 'Saved' }));
  expect(screen.getByRole('link', { name: /Task 28/ })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Mark as unread' }));
  expect(await screen.findByLabelText('1 new in your inbox')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Archive item' }));
  expect(screen.queryByLabelText('1 new in your inbox')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Archive' }));
  await user.click(screen.getByRole('button', { name: 'Restore to inbox' }));
  await user.click(screen.getByRole('button', { name: 'Activity' }));
  expect(screen.getByRole('link', { name: /Task 28/ })).toBeVisible();
});
