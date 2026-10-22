import { screen, waitFor } from '@testing-library/react';
import type { InboxItemDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, json, renderApp, singleActorRoutes } from '../../test/fakeApi';

const path = `/api/v1/workspaces/${alpha.id}/inbox`;
const id = (n: number) => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, kind: 'assigned' | 'comment', at: string, excerpt: string | null = null): InboxItemDto => ({ id: id(n), kind, at, actorName: 'Boris', excerpt, task: { id: id(n + 50), title: `Task ${n}`, projectId: id(99), projectName: 'Billing' } });
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

  it('says so when nothing happened', async () => {
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([]) });
    const { user } = renderApp(`/w/${alpha.id}`);
    await user.click(await screen.findByRole('link', { name: /Inbox/ }));
    expect(await screen.findByText('Nothing new')).toBeInTheDocument();
  });
});
