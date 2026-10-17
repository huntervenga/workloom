import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActorDto } from '@workloom/contracts';
import { Outlet, RouterProvider, createMemoryRouter, type RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { useMe } from '../features/identity/identity';
import { useProtectedDraft } from '../lib/protectedDrafts';
import { createProjectRequest } from '../features/projects/api';
import type { CreateProjectVariables } from '../features/projects/queries';
import { t } from '../i18n';
import { createQueryClient } from '../lib/queryClient';
import { isActorKey, queryKeys } from '../lib/queryKeys';
import { useIdempotentMutation } from '../lib/useIdempotentMutation';
import { alpha, anna, created, deferred, failure, installFakeApi, ok, project, singleActorRoutes, type FakeRequest, type RouteTable } from '../test/fakeApi';
import { AppRoutes } from './AppRoutes';
import { ProtectedNavigationGuard } from './ProtectedNavigationGuard';
import { SessionProvider, useSession } from './session';
import { AppShell } from './shell/AppShell';

/*
 * The real shell, session, guard, router and query client; only fetch and the full-tab
 * navigation (which JSDOM cannot perform) are replaced. Every identity here is synthetic.
 */

const realActor: ActorDto = { id: '55555555-5555-4555-8555-555555555555', displayName: 'Synthetic Real Person', kind: 'real' };
const RAW = 'raw-server-detail-never-rendered';
const PAGE = `/w/${alpha.id}/projects`;
const PROJECT_ID = 'e0000000-0000-4000-8000-000000000002';
const sent = { input: { name: 'Synthetic launch' } } satisfies CreateProjectVariables;

const assigned: string[] = [];
const editorRenders: { actorId: string; draft: string }[] = [];
const probe: { write?: ReturnType<typeof useProjectWrite> } = {};
const cleanups: (() => void)[] = [];

beforeEach(() => {
  assigned.splice(0);
  editorRenders.splice(0);
  delete probe.write;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function useProjectWrite() {
  return useIdempotentMutation({ prepare: ({ input }: CreateProjectVariables) => createProjectRequest(alpha.id, input) });
}

function WritePage() {
  probe.write = useProjectWrite();
  const me = useMe();
  const [draft, setDraft] = useState('');
  useProtectedDraft(draft.length > 0);
  editorRenders.push({ actorId: me.actor.id, draft });
  return (
    <>
      <h1>Projects</h1>
      <label>Unsent draft<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button type="button" onClick={() => probe.write?.mutate(sent)}>
        Send
      </button>
    </>
  );
}

function Root() {
  return (
    <SessionProvider assignDocument={(href) => assigned.push(href)}>
      <ProtectedNavigationGuard />
      <Outlet />
    </SessionProvider>
  );
}

/** Harness stand-in for the app routes' own unmount while a session change is underway. */
function SessionGate() {
  return useSession().switching ? null : <Outlet />;
}

function renderRoutes(routes: RouteObject[], path: string) {
  const queryClient: QueryClient = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ element: <Root />, children: routes }], { initialEntries: [path] });
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

const renderApp = (path: string) => renderRoutes([{ path: '*', element: <AppRoutes /> }], path);

const renderWriteShell = () =>
  renderRoutes(
    [
      {
        element: <SessionGate />,
        children: [{ element: <AppShell />, children: [{ path: '/', element: <h1>Home</h1> }, { path: PAGE, element: <WritePage /> }] }],
      },
    ],
    PAGE,
  );

type Answer = () => Response | Promise<Response>;

/** A shared server for the synthetic real actor; logout answers are taken in order. */
function sharedServer(config: Answer[] = [() => ok({ authMode: 'shared' })]) {
  const state = { session: true, actor: realActor, logouts: [] as FakeRequest[], projectSends: 0, logoutAnswers: [] as Answer[] };
  const lost = deferred<undefined>();
  const table: RouteTable = {
    ...singleActorRoutes(realActor, [alpha]),
    'GET /api/v1/me': () => (state.session ? ok({ actor: state.actor, authMode: 'shared' }) : failure(401, 'UNAUTHENTICATED', RAW)),
    'GET /api/v1/auth/config': () => (config.length > 1 ? config.shift() : config[0])?.() ?? failure(500, 'INTERNAL', RAW),
    'POST /api/v1/auth/logout': (request) => {
      state.logouts.push(request);
      return state.logoutAnswers.shift()?.() ?? new Response(null, { status: 204 });
    },
    [`POST /api/v1/workspaces/${alpha.id}/projects`]: async () => {
      state.projectSends += 1;
      if (state.projectSends === 1) {
        await lost.promise;
        throw new TypeError('Failed to fetch');
      }
      return created(project(alpha.id, PROJECT_ID, sent.input.name));
    },
  };
  const { calls } = installFakeApi(table);
  const configReads = () => calls.filter((call) => call.method === 'GET' && call.path === '/api/v1/auth/config').length;
  return { state, calls, configReads, lose: () => lost.resolve(undefined) };
}

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function sendAndLose(user: ReturnType<typeof userEvent.setup>, lose: () => void) {
  await user.click(await screen.findByRole('button', { name: 'Send' }));
  lose();
  await waitFor(() => expect(probe.write?.uncertain?.variables).toEqual(sent));
  await waitFor(() => expect(probe.write?.pendingCommand).toBeNull());
}

async function answerDialog(user: ReturnType<typeof userEvent.setup>, name: string, button: string) {
  const dialog = await screen.findByRole('dialog', { name });
  expect(dialog).toHaveTextContent(t('shell.mayHaveSaved'));
  await user.click(within(dialog).getByRole('button', { name: button }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

function returnToOf(href: string): string | null {
  const url = new URL(href, 'http://127.0.0.1:4311');
  expect(url.pathname).toBe('/api/v1/auth/login');
  return url.searchParams.get('returnTo');
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

describe('shared identity in the shell', () => {
  it('shows the real actor and sign-out without any local demo framing or extra reads', async () => {
    const server = sharedServer();
    renderApp(`/w/${alpha.id}`);

    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getAllByText(`Signed in as ${realActor.displayName}`).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('shell.localDemo'))).not.toBeInTheDocument();
    expect(screen.queryByText(t('shell.testShort'))).not.toBeInTheDocument();
    expect(server.calls.some((call) => call.path.startsWith('/api/v1/dev'))).toBe(false);
    expect(server.configReads()).toBe(0);
    expect(server.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('keeps the dev shell as it was and never reads the auth configuration', async () => {
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha]), 'GET /api/v1/auth/config': () => ok({ authMode: 'dev' }) });
    renderApp(`/w/${alpha.id}`);

    expect((await screen.findAllByText(t('shell.localDemo'))).length).toBeGreaterThan(0);
    await settle();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === '/api/v1/auth/config')).toBe(false);
  });

  it('offers sign-in after a 401 in shared mode, returning to the current page with its query and hash', async () => {
    const server = sharedServer();
    server.state.session = false;
    const { user } = renderApp(`${PAGE}?view=table#notes`);

    expect(await screen.findByRole('heading', { name: 'Sign in to Workloom' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Sign in' });
    expect(returnToOf(link.getAttribute('href') ?? '')).toBe(`/app${PAGE}?view=table#notes`);
    expect(document.body).not.toHaveTextContent(RAW);
    expect(server.configReads()).toBe(1);

    // Nothing is at stake: one plain click leaves for sign-in, with no write sent.
    await user.click(link);
    expect(assigned).toHaveLength(1);
    expect(returnToOf(assigned[0] ?? '')).toBe(`/app${PAGE}?view=table#notes`);
    await settle();
    expect(server.calls.some((call) => call.method !== 'GET')).toBe(false);
    expect(server.configReads()).toBe(1);
  });

  it('keeps an encoded ordinary anchor in the sign-in return path', async () => {
    const server = sharedServer();
    server.state.session = false;
    renderApp(`${PAGE}?view=table#sec%20one`);
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(returnToOf(link.getAttribute('href') ?? '')).toBe(`/app${PAGE}?view=table#sec%20one`);
  });

  it('leaves parameter-like hashes behind', async () => {
    const server = sharedServer();
    server.state.session = false;
    renderApp('/?view=list#access_token=synthetic');

    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(returnToOf(link.getAttribute('href') ?? '')).toBe('/app?view=list');
  });

  it('keeps the identity error and its retry when a 401 arrives in dev mode', async () => {
    const server = sharedServer([() => ok({ authMode: 'dev' })]);
    server.state.session = false;
    renderApp('/');

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).not.toHaveTextContent('Sign in to Workloom');
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(RAW);
    expect(server.configReads()).toBe(1);
  });

  it('offers only an explicit retry when the sign-in options cannot be read', async () => {
    const server = sharedServer([() => failure(503, 'UNAVAILABLE', RAW), () => ok({ authMode: 'shared' })]);
    server.state.session = false;
    const { user } = renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Sign-in options could not be loaded.' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(RAW);
    await settle();
    expect(server.configReads()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Workloom' })).toBeInTheDocument();
    expect(server.configReads()).toBe(2);
  });
});

describe('signing out with pending or uncertain work', () => {
  it('does nothing when the user stays', async () => {
    const server = sharedServer();
    const { user, router } = renderWriteShell();
    await sendAndLose(user, server.lose);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out?' });
    expect(within(dialog).getByRole('button', { name: 'Sign out without confirmation' })).toBeInTheDocument();
    await answerDialog(user, 'Sign out?', 'Stay');

    await settle();
    expect(server.state.logouts).toHaveLength(0);
    expect(probe.write?.uncertain?.variables).toEqual(sent);
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PAGE);
  });

  it('keeps everything while the logout is pending and forgets the actor only after a confirmed 204', async () => {
    const server = sharedServer();
    const held = deferred<undefined>();
    server.state.logoutAnswers.push(async () => {
      await held.promise;
      return new Response(null, { status: 204 });
    });
    const { user, router, queryClient } = renderWriteShell();
    await sendAndLose(user, server.lose);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await answerDialog(user, 'Sign out?', 'Sign out without confirmation');
    await waitFor(() => expect(server.state.logouts).toHaveLength(1));

    // Not confirmed yet: the screen, the uncertain command and the cache all stay.
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(probe.write?.uncertain?.variables).toEqual(sent);
    expect(queryClient.getQueryData(queryKeys.me)).toBeDefined();
    expect(unloadPrevented()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Signing out…' }));
    await settle();
    expect(server.state.logouts).toHaveLength(1);

    server.state.session = false;
    await act(async () => {
      held.resolve(undefined);
      await held.promise;
    });

    expect(await screen.findByRole('heading', { name: 'Sign in to Workloom' })).toBeInTheDocument();
    expect(screen.queryByText(realActor.displayName, { exact: false })).not.toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
    expect(queryClient.getQueryCache().findAll({ predicate: (query) => isActorKey(query.queryKey, realActor.id) })).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(unloadPrevented()).toBe(false);
    expect(router.state.location.pathname).toBe('/');
    expect(server.state.logouts).toHaveLength(1);
    expect(server.state.projectSends).toBe(1);
  });

  it('treats a lost or rejected logout as unconfirmed and sends again only on an explicit retry', async () => {
    const server = sharedServer();
    server.state.logoutAnswers.push(
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => failure(500, 'INTERNAL', RAW),
    );
    const { user, queryClient } = renderWriteShell();
    await sendAndLose(user, server.lose);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await answerDialog(user, 'Sign out?', 'Sign out without confirmation');
    expect(await screen.findByText('Sign out did not finish.')).toBeInTheDocument();
    expect(screen.getByText(/could not confirm that you were signed out/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(probe.write?.uncertain?.variables).toEqual(sent);
    expect(queryClient.getQueryData(queryKeys.me)).toBeDefined();
    expect(unloadPrevented()).toBe(true);
    await settle();
    expect(server.state.logouts).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await answerDialog(user, 'Sign out?', 'Sign out without confirmation');
    await waitFor(() => expect(server.state.logouts).toHaveLength(2));
    expect(await screen.findByText('Sign out did not finish.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(RAW);
    expect(probe.write?.uncertain?.variables).toEqual(sent);
    await settle();
    expect(server.state.logouts).toHaveLength(2);

    server.state.session = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await answerDialog(user, 'Sign out?', 'Sign out without confirmation');
    expect(await screen.findByRole('heading', { name: 'Sign in to Workloom' })).toBeInTheDocument();
    expect(server.state.logouts).toHaveLength(3);
    expect(server.state.projectSends).toBe(1);
  });
});

describe('unsent drafts across shared session changes', () => {
  it('retains an unsent editor through pending and rejected logout, and clears it only after 204', async () => {
    const server = sharedServer();
    const held = deferred<Response>();
    server.state.logoutAnswers.push(() => held.promise);
    const { user, queryClient } = renderWriteShell();
    const input = await screen.findByRole('textbox', { name: 'Unsent draft' });
    await user.type(input, 'Private unsent draft');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    let dialog = await screen.findByRole('dialog', { name: 'Sign out?' });
    expect(within(dialog).getByRole('button', { name: 'Discard and sign out' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(server.state.logouts).toHaveLength(0);
    expect(input).toHaveValue('Private unsent draft');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    dialog = await screen.findByRole('dialog', { name: 'Sign out?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard and sign out' }));
    await waitFor(() => expect(server.state.logouts).toHaveLength(1));
    expect(screen.getByRole('textbox', { name: 'Unsent draft' })).toBe(input);
    expect(input).toHaveValue('Private unsent draft');
    expect(queryClient.getQueryData(queryKeys.me)).toBeDefined();

    await act(async () => { held.resolve(failure(500, 'INTERNAL', RAW)); });
    expect(await screen.findByText('Sign out did not finish.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Unsent draft' })).toBe(input);
    expect(input).toHaveValue('Private unsent draft');
    expect(unloadPrevented()).toBe(true);
    expect(server.state.logouts).toHaveLength(1);

    server.state.session = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    dialog = await screen.findByRole('dialog', { name: 'Sign out?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard and sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Workloom' })).toBeInTheDocument();
    expect(input).not.toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
    expect(server.state.logouts).toHaveLength(2);
    expect(server.state.projectSends).toBe(0);
  });

  it('never renders the previous actor’s local draft in a newly reported actor’s frame', async () => {
    const server = sharedServer();
    const { user, queryClient } = renderWriteShell();
    await user.type(await screen.findByRole('textbox', { name: 'Unsent draft' }), 'Previous actor private draft');
    const nextActor: ActorDto = { id: '66666666-6666-4666-8666-666666666666', displayName: 'Synthetic Second Person', kind: 'real' };
    server.state.actor = nextActor;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.me }); });
    await screen.findByRole('heading', { name: 'Home' });
    expect(editorRenders.some(entry => entry.actorId === nextActor.id)).toBe(true);
    expect(editorRenders.some(entry => entry.actorId === nextActor.id && entry.draft !== '')).toBe(false);
    expect(queryClient.getQueryCache().findAll({ predicate: query => isActorKey(query.queryKey, realActor.id) })).toHaveLength(0);
    expect(server.state.projectSends).toBe(0);
    expect(server.state.logouts).toHaveLength(0);
  });
});

describe('an expired shared session', () => {
  it('hides the retained frame behind sign-in and leaves only after the user agrees', async () => {
    const server = sharedServer();
    const { user, queryClient } = renderWriteShell();
    await sendAndLose(user, server.lose);

    server.state.session = false;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    });

    expect(await screen.findByRole('heading', { name: 'Sign in to Workloom' })).toBeInTheDocument();
    // Still mounted, so the uncertain command keeps its owner, but no longer visible.
    expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(probe.write?.uncertain?.variables).toEqual(sent);
    expect(server.configReads()).toBe(0);

    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    await answerDialog(user, 'Sign in again?', 'Stay');
    expect(assigned).toHaveLength(0);
    expect(probe.write?.uncertain?.variables).toEqual(sent);

    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    await answerDialog(user, 'Sign in again?', 'Sign in without confirmation');
    expect(assigned).toHaveLength(1);
    expect(returnToOf(assigned[0] ?? '')).toBe(`/app${PAGE}`);
    expect(server.state.logouts).toHaveLength(0);
    expect(server.state.projectSends).toBe(1);
  });
});
