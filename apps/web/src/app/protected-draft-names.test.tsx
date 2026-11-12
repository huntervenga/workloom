import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { Link, Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { createQueryClient } from '../lib/queryClient';
import { protectedDraftsFor, useProtectedDraft } from '../lib/protectedDrafts';
import { useQueryClient } from '@tanstack/react-query';
import { installFakeApi } from '../test/fakeApi';
import { ProtectedNavigationGuard } from './ProtectedNavigationGuard';
import { SessionProvider } from './session';

/*
 * Kept drafts name themselves, so "Leave this page?" says what would be lost: a named form and a
 * slot whose names change while it stays dirty (like retained task edits). Unnamed drafts still ask.
 */

const live: { names: string[] } = { names: [] };

function DraftPage({ named }: { named: boolean }) {
  useProtectedDraft(true, named ? 'A new section name' : undefined);
  const client = useQueryClient();
  useEffect(() => {
    if (!named) return;
    const entry = protectedDraftsFor(client).register(() => live.names);
    entry.set(true);
    return entry.dispose;
  }, [client, named]);
  return <><h1>Project</h1><Link to="/elsewhere">Leave</Link></>;
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function renderPage(named: boolean) {
  installFakeApi({});
  const queryClient = createQueryClient({ retry: false });
  const router = createMemoryRouter([{
    element: <SessionProvider><ProtectedNavigationGuard /><Outlet /></SessionProvider>,
    children: [{ path: '/page', element: <DraftPage named={named} /> }, { path: '/elsewhere', element: <h1>Elsewhere</h1> }],
  }], { initialEntries: ['/page'] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { router.dispose(); queryClient.clear(); });
  return userEvent.setup({ pointerEventsCheck: 0 });
}

it('lists every kept draft by name when leaving, with names read at the moment it asks', async () => {
  live.names = ['Changes to the task “QA”'];
  const user = renderPage(true);
  live.names = ['Changes to the task “QA”', 'A new task “Client support”'];
  await user.click(await screen.findByRole('link', { name: 'Leave' }));
  const dialog = await screen.findByRole('dialog', { name: 'Leave this page?' });
  expect(within(dialog).getByText('Not saved yet:')).toBeInTheDocument();
  expect(within(dialog).getAllByRole('listitem').map(item => item.textContent)).toEqual(['A new section name', 'Changes to the task “QA”', 'A new task “Client support”']);
  await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'Project' })).toBeInTheDocument();
});

it('still asks for an unnamed draft, without an empty list', async () => {
  const user = renderPage(false);
  await user.click(await screen.findByRole('link', { name: 'Leave' }));
  const dialog = await screen.findByRole('dialog', { name: 'Leave this page?' });
  expect(within(dialog).queryByText('Not saved yet:')).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Leave without saving' }));
  expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeInTheDocument();
});
