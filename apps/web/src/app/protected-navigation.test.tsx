import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Outlet, RouterProvider, createMemoryRouter, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectRequest } from '../features/projects/api';
import type { CreateProjectVariables } from '../features/projects/queries';
import { PendingCommandError } from '../lib/idempotency';
import { createQueryClient } from '../lib/queryClient';
import { queryKeys } from '../lib/queryKeys';
import { useIdempotentMutation } from '../lib/useIdempotentMutation';
import { alpha, anna, boris, created, deferred, installFakeApi, project } from '../test/fakeApi';
import { ProtectedNavigationGuard } from './ProtectedNavigationGuard';
import { SessionProvider, useSession, type SessionContextValue } from './session';

/*
 * The real write hook and the real guard in a data router; only fetch is replaced. The page owns
 * the hook and shows no form, like a closed dialog keeping its command.
 */

const PAGE = `/w/${alpha.id}/projects`;
const PROJECT_ID = 'e0000000-0000-4000-8000-000000000001';
const sent = { input: { name: 'Запуск' } } satisfies CreateProjectVariables;

function useProjectWrite() {
  return useIdempotentMutation({ prepare: ({ input }: CreateProjectVariables) => createProjectRequest(alpha.id, input) });
}

const probe: { write?: ReturnType<typeof useProjectWrite>; session?: SessionContextValue } = {};

function WritePage() {
  probe.write = useProjectWrite();
  probe.session = useSession();
  const [, setSearchParams] = useSearchParams();
  return (
    <>
      <h1>Projects</h1>
      <button type="button" onClick={() => probe.write?.mutate(sent)}>
        Отправить
      </button>
      <button type="button" onClick={() => setSearchParams({ task: '1' })}>
        Открыть задачу
      </button>
      <Link to="/elsewhere">Уйти по ссылке</Link>
    </>
  );
}

function Shell() {
  return (
    <SessionProvider>
      <ProtectedNavigationGuard />
      <Outlet />
    </SessionProvider>
  );
}

const cleanups: (() => void)[] = [];

beforeEach(() => {
  delete probe.write;
  delete probe.session;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The first send is held until `lose()`, then fails in transport; later sends are confirmed. */
function server() {
  const sends: { key: string | null; body: unknown }[] = [];
  const gate = deferred<undefined>();
  installFakeApi({
    [`POST /api/v1/workspaces/${alpha.id}/projects`]: async (request) => {
      sends.push({ key: request.headers.get('Idempotency-Key'), body: request.body });
      if (sends.length === 1) {
        await gate.promise;
        throw new TypeError('Failed to fetch');
      }
      return created(project(alpha.id, PROJECT_ID, 'Запуск'));
    },
  });
  return { sends, lose: () => gate.resolve(undefined) };
}

function renderGuarded(queryClient: QueryClient = createQueryClient({ retry: false })) {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/', element: <h1>Начало</h1> },
          { path: PAGE, element: <WritePage /> },
          { path: '/elsewhere', element: <h1>Другая страница</h1> },
        ],
      },
    ],
    { initialEntries: ['/', PAGE], initialIndex: 1 },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  cleanups.push(() => {
    router.dispose();
    queryClient.clear();
  });
  return { router, queryClient, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function sendAndLose(user: ReturnType<typeof userEvent.setup>, lose: () => void) {
  await user.click(await screen.findByRole('button', { name: 'Отправить' }));
  lose();
  await waitFor(() => expect(probe.write?.uncertain?.variables).toEqual(sent));
  await waitFor(() => expect(probe.write?.pendingCommand).toBeNull());
}

async function stayOn(user: ReturnType<typeof userEvent.setup>, dialogName: string) {
  const dialog = await screen.findByRole('dialog', { name: dialogName });
  await user.click(within(dialog).getByRole('button', { name: "Stay" }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('departing with a pending or uncertain write', () => {
  it('blocks links, navigate() and back while pending or lost, and keeps the command retryable with its key', async () => {
    const { sends, lose } = server();
    const { router, user } = renderGuarded();
    expect(await screen.findByRole('heading', { name: "Projects" })).toBeInTheDocument();
    expect(unloadPrevented()).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(unloadPrevented()).toBe(true));

    // Neither an identical nor a different call may replace the command in flight.
    const refused: unknown[] = [];
    act(() => probe.write?.mutate(sent, { onError: (error) => refused.push(error) }));
    act(() => probe.write?.mutate({ input: { name: 'Другой' } }, { onError: (error) => refused.push(error) }));
    expect(refused).toEqual([expect.any(PendingCommandError), expect.any(PendingCommandError)]);
    expect(probe.write?.pendingCommand?.variables).toEqual(sent);
    expect(sends).toHaveLength(1);

    // Opening a task only changes the query string: no prompt.
    await user.click(screen.getByRole('button', { name: 'Открыть задачу' }));
    expect(router.state.location.search).toBe('?task=1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Уйти по ссылке' }));
    expect(await screen.findByRole('dialog', { name: "Leave this page?" })).toHaveTextContent('The server may have saved');
    await stayOn(user, "Leave this page?");
    expect(router.state.location.pathname).toBe(PAGE);

    lose();
    await waitFor(() => expect(probe.write?.uncertain?.variables).toEqual(sent));
    await waitFor(() => expect(probe.write?.pendingCommand).toBeNull());
    expect(unloadPrevented()).toBe(true);

    await act(async () => {
      await router.navigate('/elsewhere');
    });
    await stayOn(user, "Leave this page?");
    expect(router.state.location.pathname).toBe(PAGE);

    // Browser back over the query-only entry stays on the page: no prompt.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe(PAGE);
    expect(router.state.location.search).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Browser back to another page is blocked.
    await act(async () => {
      await router.navigate(-1);
    });
    await stayOn(user, "Leave this page?");
    expect(router.state.location.pathname).toBe(PAGE);
    expect(screen.queryByRole('heading', { name: 'Начало' })).not.toBeInTheDocument();

    act(() => probe.write?.retryUncertain());
    await waitFor(() => expect(probe.write?.isSuccess).toBe(true));
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(probe.write?.uncertain).toBeNull();
    await waitFor(() => expect(unloadPrevented()).toBe(false));

    await user.click(screen.getByRole('link', { name: 'Уйти по ссылке' }));
    expect(await screen.findByRole('heading', { name: 'Другая страница' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('leaves only after a warning that the server may have saved and the retry state is dropped', async () => {
    const { sends, lose } = server();
    const { router, user } = renderGuarded();
    await sendAndLose(user, lose);

    await user.click(screen.getByRole('link', { name: 'Уйти по ссылке' }));
    const dialog = await screen.findByRole('dialog', { name: "Leave this page?" });
    expect(dialog).toHaveTextContent('The server may have saved');
    expect(dialog).toHaveTextContent('clear the values needed to retry');
    expect(dialog).toHaveTextContent('check what the server already saved');
    await user.click(within(dialog).getByRole('button', { name: "Leave without confirmation" }));

    expect(await screen.findByRole('heading', { name: 'Другая страница' })).toBeInTheDocument();
    expect(unloadPrevented()).toBe(false);

    // The page's hook is gone with its command: coming back starts clean and nothing was resent.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(await screen.findByRole('heading', { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(probe.write?.uncertain).toBeNull();
    expect(sends).toHaveLength(1);
  });

  it('asks before an explicit actor switch and does nothing when the user stays', async () => {
    const { lose } = server();
    const { router, user } = renderGuarded();
    await sendAndLose(user, lose);
    const changeSession = vi.fn(() => Promise.resolve());

    let switching: Promise<void> | undefined;
    act(() => {
      switching = probe.session?.switchActor(changeSession);
    });
    await stayOn(user, "Switch user?");
    await act(async () => {
      await switching;
    });
    expect(changeSession).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe(PAGE);
    expect(probe.write?.uncertain?.variables).toEqual(sent);

    act(() => {
      switching = probe.session?.switchActor(changeSession);
    });
    const dialog = await screen.findByRole('dialog', { name: "Switch user?" });
    await user.click(within(dialog).getByRole('button', { name: "Switch without confirmation" }));
    await act(async () => {
      await switching;
    });
    expect(changeSession).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/');
    expect(unloadPrevented()).toBe(false);
  });

  it('never holds back the cleanup after the server reports another actor', async () => {
    const { lose } = server();
    const queryClient = createQueryClient({ retry: false });
    queryClient.setQueryData(queryKeys.me, { actor: anna, authMode: 'dev' });
    const { router, user } = renderGuarded(queryClient);
    await sendAndLose(user, lose);
    expect(unloadPrevented()).toBe(true);

    act(() => queryClient.setQueryData(queryKeys.me, { actor: boris, authMode: 'dev' }));
    await act(async () => {
      await router.navigate('/', { replace: true });
    });

    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(unloadPrevented()).toBe(false);
  });
});
