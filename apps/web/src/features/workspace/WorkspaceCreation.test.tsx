import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActorDto, WorkspaceDto } from '@workloom/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { t } from '../../i18n';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, created, deferred, failure, installFakeApi, ok, singleActorRoutes, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { browserTimezone } from './workspaceCreationController';

const realActor: ActorDto = { id: '55555555-5555-4555-8555-555555555555', displayName: 'Synthetic Real Person', kind: 'real' };
const nextActor: ActorDto = { id: '66666666-6666-4666-8666-666666666666', displayName: 'Synthetic Second Person', kind: 'real' };
const fresh: WorkspaceDto = { id: 'f0000000-0000-4000-8000-000000000001', name: 'Synthetic new team', timezone: 'Europe/Berlin', role: 'owner' };
const freshProjects = `/w/${fresh.id}/projects`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type Answer = (request: FakeRequest) => Response | Promise<Response>;

/** A shared server for one real account; the create answer and list reads are scripted per test. */
function server({ workspaces = [] as WorkspaceDto[], actor = realActor, authMode = 'shared' as 'shared' | 'dev', create, list }: {
  workspaces?: WorkspaceDto[]; actor?: ActorDto; authMode?: 'shared' | 'dev'; create?: Answer; list?: (count: number) => Response | Promise<Response> | null;
} = {}) {
  const state = { actor, session: true, workspaces: [...workspaces], listReads: 0 };
  const table: RouteTable = {
    ...singleActorRoutes(actor, workspaces),
    'GET /api/v1/me': () => (state.session ? ok({ actor: state.actor, authMode }) : failure(401, 'UNAUTHENTICATED', 'raw server text')),
    'GET /api/v1/auth/config': () => ok({ authMode }),
    'GET /api/v1/workspaces': async () => {
      state.listReads += 1;
      return (await list?.(state.listReads)) ?? ok(state.workspaces);
    },
    'POST /api/v1/workspaces': async (request) => {
      const answer = create ? await create(request) : created(fresh);
      // The new workspace belongs only to the account that sent it.
      if (answer.ok && request.headers.get('X-Workloom-Actor-ID') === state.actor.id && !state.workspaces.includes(fresh)) {
        state.workspaces = [...state.workspaces, fresh];
      }
      return answer;
    },
    [`GET /api/v1/workspaces/${fresh.id}`]: () => ok(fresh),
    [`GET /api/v1/workspaces/${fresh.id}/memberships`]: () => ok([]),
    [`GET /api/v1/workspaces/${fresh.id}/projects`]: () => ok([]),
  };
  const { calls } = installFakeApi(table);
  const creates = () => calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/workspaces');
  return { state, calls, creates };
}

function app(url = '/') {
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { client, router, user: userEvent.setup({ pointerEventsCheck: 0 }), path: () => router.state.location.pathname };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const main = () => within(screen.getByRole('main'));
const sidebar = () => within(screen.getByRole('complementary', { name: 'Sidebar' }));
const creationDialog = () => screen.findByRole('dialog', { name: 'New workspace' });
const fields = (dialog: HTMLElement) => ({ name: within(dialog).getByLabelText('Workspace name'), timezone: within(dialog).getByLabelText('Time zone') });

async function openFromHome(ui: ReturnType<typeof app>) {
  await screen.findByRole('heading', { level: 1, name: 'No workspaces available' });
  await ui.user.click(main().getByRole('button', { name: 'New workspace' }));
  return creationDialog();
}

async function fill(ui: ReturnType<typeof app>, dialog: HTMLElement, name: string, timezone = 'Europe/Berlin') {
  const field = fields(dialog);
  await ui.user.clear(field.name);
  await ui.user.type(field.name, name);
  await ui.user.clear(field.timezone);
  await ui.user.type(field.timezone, timezone);
}

describe('workspace creation availability', () => {
  it.each([
    ['a local fixture actor', anna, 'dev' as const],
    ['a fixture actor in a shared session', anna, 'shared' as const],
  ])('offers nothing to %s, on the empty home page or in the chooser', async (_label, actor, authMode) => {
    const api = server({ actor, authMode });
    app();
    await screen.findByRole('heading', { level: 1, name: 'No workspaces available' });
    await settle();
    expect(screen.queryByRole('button', { name: 'New workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.creates()).toHaveLength(0);
  });

  it('offers a real shared account a visible action on the empty home page and in the chooser, and never creates by itself', async () => {
    const api = server();
    app();
    await screen.findByRole('heading', { level: 1, name: 'No workspaces available' });
    expect(main().getByRole('button', { name: 'New workspace' })).toBeVisible();
    expect(sidebar().getByRole('button', { name: 'New workspace' })).toBeVisible();
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.creates()).toHaveLength(0);
  });

  it('adds the action to the chooser menu of a real shared account and returns focus to the chooser', async () => {
    const api = server({ workspaces: [alpha] });
    const ui = app(`/w/${alpha.id}`);
    const trigger = await within(await screen.findByRole('complementary', { name: 'Sidebar' })).findByRole('button', { name: new RegExp(alpha.name) });
    await ui.user.click(trigger);
    await ui.user.click(await screen.findByRole('menuitem', { name: 'New workspace' }));
    const dialog = await creationDialog();
    // Opening never moves the current context and copies nothing from the open workspace.
    expect(ui.path()).toBe(`/w/${alpha.id}`);
    expect(fields(dialog).name).toHaveValue('');
    expect(fields(dialog).timezone).toHaveValue(browserTimezone());
    await ui.user.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(api.creates()).toHaveLength(0);
  });
});

describe('creating a workspace', () => {
  it('sends the trimmed name and time zone with a key and the actor header, publishes the result and opens its projects', async () => {
    const stale = deferred<Response>();
    const api = server({ list: (count) => (count === 2 ? stale.promise : null) });
    const ui = app();
    const dialog = await openFromHome(ui);
    await fill(ui, dialog, '  Synthetic new team  ');
    // An older list read is still in flight when the create is confirmed.
    act(() => { void ui.client.invalidateQueries({ queryKey: queryKeys.workspaces(realActor.id), exact: true }); });
    await waitFor(() => expect(api.state.listReads).toBe(2));

    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(ui.path()).toBe(freshProjects));

    const [sent] = api.creates();
    expect(api.creates()).toHaveLength(1);
    expect(sent?.body).toEqual({ name: 'Synthetic new team', timezone: 'Europe/Berlin' });
    expect(sent?.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(sent?.headers.get('X-Workloom-Actor-ID')).toBe(realActor.id);
    expect(ui.client.getQueryData(queryKeys.workspace(realActor.id, fresh.id))).toEqual(fresh);
    await waitFor(() => expect(ui.client.getQueryData(queryKeys.workspaces(realActor.id))).toEqual([fresh]));

    // The cancelled older read answers late without the new workspace; it must not win.
    stale.resolve(ok([]));
    await settle();
    expect(ui.client.getQueryData(queryKeys.workspaces(realActor.id))).toEqual([fresh]);
    expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument();
    // Own protection was released before navigating, so the guard did not ask.
    expect(screen.queryByRole('dialog', { name: t('shell.leaveQuestion') })).not.toBeInTheDocument();
    expect(protectedCommandsFor(ui.client).protecting).toBe(false);
    expect(protectedDraftsFor(ui.client).protecting).toBe(false);
  });

  it('checks the draft before sending and keeps it editable after a confirmed rejection', async () => {
    const api = server({ create: () => failure(400, 'VALIDATION_ERROR', 'raw server text') });
    const ui = app();
    const dialog = await openFromHome(ui);
    const field = fields(dialog);

    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    expect(within(dialog).getByText('Enter a workspace name.')).toBeVisible();
    expect(field.name).toHaveFocus();
    await fill(ui, dialog, 'Synthetic new team', 'Mars/Olympus');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    expect(within(dialog).getByText(t('workspace.create.timezoneInvalid'))).toBeVisible();
    expect(api.creates()).toHaveLength(0);

    await ui.user.clear(field.timezone);
    await ui.user.type(field.timezone, 'Europe/Berlin');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    expect(await within(dialog).findByText(t('workspace.create.rejectedInput'))).toBeVisible();
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
    expect(field.name).not.toHaveAttribute('readonly');
    expect(field.name).toHaveValue('Synthetic new team');
    expect(ui.path()).toBe('/');
    expect(protectedCommandsFor(ui.client).protecting).toBe(false);
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);

    await ui.user.type(field.name, ' two');
    expect(field.name).toHaveValue('Synthetic new team two');
    expect(api.creates()).toHaveLength(1);
  });

  it('sends one request for a double click and locks the fields while it is pending', async () => {
    const answer = deferred<Response>();
    const api = server({ create: () => answer.promise });
    const ui = app();
    const dialog = await openFromHome(ui);
    await fill(ui, dialog, 'Synthetic new team');
    const submit = within(dialog).getByRole('button', { name: 'Create workspace' });
    await ui.user.dblClick(submit);
    await ui.user.click(submit);
    expect(within(dialog).getByRole('button', { name: t('workspace.create.creating') })).toHaveAttribute('aria-disabled', 'true');
    expect(fields(dialog).name).toHaveAttribute('readonly');
    expect(fields(dialog).timezone).toHaveAttribute('readonly');
    expect(api.creates()).toHaveLength(1);
    expect(protectedCommandsFor(ui.client).protecting).toBe(true);

    answer.resolve(created(fresh));
    await waitFor(() => expect(ui.path()).toBe(freshProjects));
    expect(api.creates()).toHaveLength(1);
  });

  it('keeps an unconfirmed create with its exact body and key through closing, a mobile trigger unmount and reopening; only Retry resends it', async () => {
    const lost = deferred<undefined>();
    let sends = 0;
    const api = server({
      create: async () => {
        sends += 1;
        if (sends === 1) {
          await lost.promise;
          throw new TypeError('Failed to fetch');
        }
        return created(fresh);
      },
    });
    const ui = app();
    const dialog = await openFromHome(ui);
    await fill(ui, dialog, 'Synthetic new team');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    lost.resolve(undefined);
    expect(await within(dialog).findByText(t('workspace.create.uncertainTitle'))).toBeVisible();
    expect(fields(dialog).name).toHaveAttribute('readonly');
    expect(protectedCommandsFor(ui.client).protecting).toBe(true);

    await ui.user.click(within(dialog).getByRole('button', { name: t('common.hide') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument());
    // Reopen from the mobile menu; choosing the action closes (unmounts) that menu.
    await ui.user.click(screen.getByRole('button', { name: t('shell.openMenu') }));
    const menu = await screen.findByRole('dialog', { name: t('shell.navigation') });
    await ui.user.click(within(menu).getByRole('button', { name: 'New workspace' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('shell.navigation') })).not.toBeInTheDocument());
    const reopened = await creationDialog();
    expect(fields(reopened).name).toHaveValue('Synthetic new team');
    expect(fields(reopened).name).toHaveAttribute('readonly');
    expect(within(reopened).getByText(t('workspace.create.uncertainTitle'))).toBeVisible();
    await settle();
    // Nothing was resent by closing, reopening, focus or reconnect.
    expect(api.creates()).toHaveLength(1);

    await ui.user.click(within(reopened).getByRole('button', { name: t('workspace.create.retry') }));
    await waitFor(() => expect(ui.path()).toBe(freshProjects));
    const [first, retry] = api.creates();
    expect(api.creates()).toHaveLength(2);
    expect(retry?.body).toEqual(first?.body);
    expect(retry?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(retry?.headers.get('X-Workloom-Actor-ID')).toBe(realActor.id);
  });
});

describe('creation and identity changes', () => {
  it('publishes nothing and stays put when the actor changes before the answer arrives', async () => {
    const answer = deferred<Response>();
    const api = server({ create: () => answer.promise });
    const ui = app();
    const dialog = await openFromHome(ui);
    await fill(ui, dialog, 'Synthetic new team');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    expect(api.creates()).toHaveLength(1);

    api.state.actor = nextActor;
    await act(() => ui.client.refetchQueries({ queryKey: queryKeys.me }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument());
    answer.resolve(created(fresh));
    await settle();

    expect(ui.path()).toBe('/');
    for (const actor of [realActor, nextActor]) {
      expect(ui.client.getQueryData(queryKeys.workspace(actor.id, fresh.id))).toBeUndefined();
      expect(ui.client.getQueryData<WorkspaceDto[]>(queryKeys.workspaces(actor.id)) ?? []).not.toContainEqual(fresh);
    }
    expect(api.creates()).toHaveLength(1);
    // The new actor's owner starts clean: no inherited draft, command or dialog.
    await ui.user.click(await main().findByRole('button', { name: 'New workspace' }));
    expect(fields(await creationDialog()).name).toHaveValue('');
    expect(protectedCommandsFor(ui.client).protecting).toBe(false);
  });

  it('holds a confirmed answer that arrives behind the sign-in gate and resends the same command after sign-in', async () => {
    const answer = deferred<Response>();
    let sends = 0;
    const api = server({ create: () => (++sends === 1 ? answer.promise : created(fresh)) });
    const ui = app();
    const dialog = await openFromHome(ui);
    await fill(ui, dialog, 'Synthetic new team');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));

    api.state.session = false;
    await act(() => ui.client.refetchQueries({ queryKey: queryKeys.me }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument());
    answer.resolve(created(fresh));
    await settle();
    expect(ui.client.getQueryData(queryKeys.workspace(realActor.id, fresh.id))).toBeUndefined();
    expect(ui.path()).toBe('/');

    api.state.session = true;
    await act(() => ui.client.refetchQueries({ queryKey: queryKeys.me }));
    const held = await creationDialog();
    expect(within(held).getByText(t('workspace.create.identityChangedTitle'))).toBeVisible();
    expect(fields(held).name).toHaveAttribute('readonly');
    expect(api.creates()).toHaveLength(1);

    await ui.user.click(within(held).getByRole('button', { name: t('workspace.create.retry') }));
    await waitFor(() => expect(ui.path()).toBe(freshProjects));
    const [first, retry] = api.creates();
    expect(retry?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(retry?.body).toEqual(first?.body);
  });
});

describe('creation drafts and other owners', () => {
  it('keeps an unsent draft through hide and reopen, protects it, and Discard clears only this draft', async () => {
    server({ workspaces: [] });
    const ui = app();
    const dialog = await openFromHome(ui);
    await ui.user.type(fields(dialog).name, 'Half-typed team');
    await ui.user.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument());
    // Opened from the empty home page, focus returns to that same visible action.
    expect(main().getByRole('button', { name: t('workspace.create.open') })).toHaveFocus();
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);

    await act(async () => ui.router.navigate(`/w/${alpha.id}`));
    const leave = await screen.findByRole('dialog', { name: t('shell.leaveQuestion') });
    await ui.user.click(within(leave).getByRole('button', { name: t('shell.stay') }));
    expect(ui.path()).toBe('/');

    const other = protectedDraftsFor(ui.client).register();
    other.set(true);
    cleanups.push(other.dispose);
    await ui.user.click(main().getByRole('button', { name: 'New workspace' }));
    const reopened = await creationDialog();
    expect(fields(reopened).name).toHaveValue('Half-typed team');
    await ui.user.click(within(reopened).getByRole('button', { name: t('workspace.create.discard') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument());
    // Another owner's draft is still protected.
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);
    other.set(false);
    expect(protectedDraftsFor(ui.client).protecting).toBe(false);
    await ui.user.click(main().getByRole('button', { name: 'New workspace' }));
    expect(fields(await creationDialog()).name).toHaveValue('');
  });

  it('returns focus to the mobile menu trigger after the mobile drawer that opened it has unmounted, keeping the draft', async () => {
    server();
    const ui = app();
    await screen.findByRole('heading', { level: 1, name: t('workspace.noneAvailable') });
    const openMenu = screen.getByRole('button', { name: t('shell.openMenu') });
    await ui.user.click(openMenu);
    const menu = await screen.findByRole('dialog', { name: t('shell.navigation') });
    await ui.user.click(within(menu).getByRole('button', { name: t('workspace.create.open') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('shell.navigation') })).not.toBeInTheDocument());
    const dialog = await screen.findByRole('dialog', { name: t('workspace.create.title') });
    await ui.user.type(fields(dialog).name, 'Mobile draft team');

    await ui.user.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('workspace.create.title') })).not.toBeInTheDocument());
    expect(openMenu).toHaveFocus();
    expect(document.body).not.toHaveFocus();
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);

    await ui.user.click(openMenu);
    const again = await screen.findByRole('dialog', { name: t('shell.navigation') });
    await ui.user.click(within(again).getByRole('button', { name: t('workspace.create.open') }));
    const reopened = await screen.findByRole('dialog', { name: t('workspace.create.title') });
    expect(fields(reopened).name).toHaveValue('Mobile draft team');
  });

  it.each([
    ['an unconfirmed command', protectedCommandsFor, 'shell.leaveUnconfirmed'],
    ['an unsaved draft', protectedDraftsFor, 'shell.leaveUnsaved'],
  ] as const)('from the empty home page, keeps another owner\'s %s, lets the guard ask, and still opens the new projects page', async (_label, registryFor, leaveKey) => {
    const api = server({ workspaces: [] });
    const ui = app('/');
    const foreign = registryFor(ui.client).register();
    cleanups.push(foreign.dispose);
    foreign.set(true);
    const dialog = await openFromHome(ui);
    await fill(ui, dialog, 'Synthetic new team');
    await ui.user.click(within(dialog).getByRole('button', { name: t('workspace.create.submit') }));

    const leave = await screen.findByRole('dialog', { name: t('shell.leaveQuestion') });
    expect(ui.client.getQueryData(queryKeys.workspace(realActor.id, fresh.id))).toEqual(fresh);
    // Let the home page see the published list and redirect while the guard is still asking:
    // that redirect must keep the projects target rather than replace it.
    await waitFor(() => expect(ui.client.getQueryData(queryKeys.workspaces(realActor.id))).toEqual([fresh]));
    await settle();
    expect(ui.path()).toBe('/');
    expect(leave).toBeInTheDocument();

    await ui.user.click(within(leave).getByRole('button', { name: t(leaveKey) }));
    await waitFor(() => expect(ui.path()).toBe(freshProjects));
    await settle();
    expect(ui.path()).toBe(freshProjects);
    expect(api.creates()).toHaveLength(1);
    // The other owner's protection was neither cleared nor taken over.
    expect(registryFor(ui.client).protecting).toBe(true);
  });

  it('leaves another owner\'s unconfirmed command in place and lets the guard ask before opening the new workspace', async () => {
    const api = server({ workspaces: [alpha] });
    const ui = app(`/w/${alpha.id}`);
    const foreign = protectedCommandsFor(ui.client).register();
    cleanups.push(foreign.dispose);
    await ui.user.click(await within(await screen.findByRole('complementary', { name: 'Sidebar' })).findByRole('button', { name: new RegExp(alpha.name) }));
    await ui.user.click(await screen.findByRole('menuitem', { name: 'New workspace' }));
    const dialog = await creationDialog();
    foreign.set(true);
    await fill(ui, dialog, 'Synthetic new team');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));

    const leave = await screen.findByRole('dialog', { name: t('shell.leaveQuestion') });
    expect(ui.client.getQueryData(queryKeys.workspace(realActor.id, fresh.id))).toEqual(fresh);
    expect(protectedCommandsFor(ui.client).protecting).toBe(true);
    await ui.user.click(within(leave).getByRole('button', { name: t('shell.leaveUnconfirmed') }));
    await waitFor(() => expect(ui.path()).toBe(freshProjects));
    expect(api.creates()).toHaveLength(1);
  });
});
