import { planningCheckSettingsSchema, projectRowSchema, type TaskDto } from '@workloom/contracts';
import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../../app/AppRoutes';
import { SessionProvider } from '../../app/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, boris, deferred, failure, installFakeApi, ok, project, renderApp, type RouteTable } from '../../test/fakeApi';
import { lostResponse } from '../planning/test/fixtures';
import { rootPath, task, tablePath, tableRoutes as legacyTableRoutes } from '../work-categories/test/fixtures';
import { queryKeys } from '../../lib/queryKeys';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';

beforeAll(async () => { await import('../../routes/ProjectPage'); });
// These owner races use a real existing home task, with no additional project memberships.
// Supply its actual home-row projection so an unrelated missing-route 404 cannot start a
// workspace authorization recheck and consume the race's deliberately numbered root read.
function tableRoutes(currentTask: () => TaskDto = () => task): RouteTable {
  return {
    ...legacyTableRoutes(),
    // This owner-race fixture is an unconfigured project. Model its ordinary analytical reads
    // explicitly: a missing unrelated settings route would trigger a genuine 404 access recheck
    // and consume the numbered root response reserved for the tested metadata race.
    [`GET ${rootPath}/projects/${task.projectId}/planning-checks/settings`]: () => ok(planningCheckSettingsSchema.parse({ workspaceId: alpha.id, projectId: task.projectId, revision: 0, config: { enabled: false, rules: [] } })),
    [`GET ${rootPath}/projects/${task.projectId}/rows`]: () => {
      const canonicalTask = currentTask();
      return ok([projectRowSchema.parse({
        placement: {
          id: canonicalTask.id, workspaceId: canonicalTask.workspaceId, taskId: canonicalTask.id,
          projectId: canonicalTask.projectId, homeProjectId: canonicalTask.projectId,
          sectionId: canonicalTask.sectionId, position: canonicalTask.position, revision: canonicalTask.revision,
          archivedAt: canonicalTask.archivedAt, createdAt: canonicalTask.createdAt, updatedAt: canonicalTask.updatedAt,
        },
        canonicalTask,
        canonicalStatus: { id: canonicalTask.statusId, workspaceId: canonicalTask.workspaceId,
          projectId: canonicalTask.projectId, name: 'Запланировано', group: 'todo', position: 0, revision: 1 },
        homeProject: project(canonicalTask.workspaceId, canonicalTask.projectId, 'Недельный пилот'),
      })]);
    },
  };
}

const headPath = `${rootPath}/change-head`;
function head(sequence = '0') {
  return { workspaceId: alpha.id, actorUserId: anna.id, membershipId: alphaMembers[0]?.id,
    membershipRevision: 1, role: 'owner', changeSeq: sequence, permissionEpoch: '0' };
}

async function settle() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }

describe('real shell/project owner protection against an obsolete head denial', () => {
  it('keeps a dirty inline task session, focus, selection and cache when its pre-editor head returns 403', async () => {
    const delayed = deferred<Response>(); let reads = 0;
    const api = installFakeApi({ ...tableRoutes(), [`GET ${headPath}`]: () => ++reads === 1 ? delayed.promise : ok(head('4')) });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await waitFor(() => expect(reads).toBe(1));
      await ui.user.click(await screen.findByRole('button', { name: task.title }));
      const input = screen.getByLabelText<HTMLInputElement>('Task name');
      fireEvent.change(input, { target: { value: 'Exact retained local draft' } }); input.setSelectionRange(2, 8);
      await waitFor(() => expect(protectedDraftsFor(ui.queryClient).protecting).toBe(true));
      const cachedProject = ui.queryClient.getQueryData(queryKeys.project(anna.id, alpha.id, task.projectId));
      await act(async () => delayed.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Synthetic obsolete denial'))); await settle();
      expect(screen.getByRole('table')).toBeInTheDocument(); expect(screen.queryByText('Workspace unavailable')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Task name')).toBe(input); expect(input).toHaveValue('Exact retained local draft');
      expect(input).toHaveFocus(); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
      expect(ui.queryClient.getQueryData(queryKeys.project(anna.id, alpha.id, task.projectId))).toBe(cachedProject);
      expect(protectedDraftsFor(ui.queryClient).protecting).toBe(true); expect(reads).toBe(1);
      fireEvent.change(input, { target: { value: task.title } }); await ui.user.keyboard('{Escape}');
      await waitFor(() => expect(reads).toBe(2)); await settle();
      expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
      expect(ui.queryClient.getQueryState(queryKeys.workspace(anna.id, alpha.id))?.status).toBe('success');
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });

  it('keeps the actual uncertain command owner and exact retry body/key after a pre-command head returns 403', async () => {
    const delayed = deferred<Response>(); const lost = lostResponse(); let reads = 0; let writes = 0; let current = task;
    const api = installFakeApi({ ...tableRoutes(() => current), [`GET ${headPath}`]: () => ++reads === 1 ? delayed.promise : ok(head('7')),
      [`GET ${rootPath}/tasks`]: () => ok([current]),
      [`PATCH ${rootPath}/tasks/${task.id}`]: request => ++writes === 1 ? lost.promise : ok(current = { ...task, title: (request.body as { title: string }).title, revision: 2 }) });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await waitFor(() => expect(reads).toBe(1));
      await ui.user.click(await screen.findByRole('button', { name: task.title }));
      fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Held exact title' } });
      await ui.user.keyboard('{Control>}{Enter}{/Control}'); await waitFor(() => expect(writes).toBe(1));
      await act(async () => lost.lose()); await screen.findByRole('button', { name: 'Retry' });
      expect(protectedCommandsFor(ui.queryClient).protecting).toBe(true);
      const original = api.calls.find(call => call.method === 'PATCH');
      await act(async () => delayed.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Synthetic obsolete denial'))); await settle();
      expect(screen.getByRole('table')).toBeInTheDocument(); expect(screen.getByLabelText('Task name')).toHaveValue('Held exact title');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(); expect(writes).toBe(1); expect(reads).toBe(1);
      expect(protectedCommandsFor(ui.queryClient).protecting).toBe(true);
      await ui.user.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(writes).toBe(2));
      const sent = api.calls.filter(call => call.method === 'PATCH');
      expect(sent[1]?.body).toEqual(original?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(original?.headers.get('Idempotency-Key'));
      await waitFor(() => expect(protectedCommandsFor(ui.queryClient).protecting).toBe(false));
      await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });

  it('hides idle cached content after a head denial, keeps the sentinel stopped, and requires explicit current root recovery', async () => {
    const delayed = deferred<Response>(); let reads = 0; let rootReads = 0;
    installFakeApi({ ...tableRoutes(), [`GET ${rootPath}`]: () => { rootReads++; return ok(alpha); }, [`GET ${headPath}`]: () => ++reads === 1 ? delayed.promise : ok(head('3')) });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await waitFor(() => expect(reads).toBe(1));
      await act(async () => delayed.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Synthetic idle denial')));
      await screen.findByText('Workspace unavailable');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(ui.queryClient.getQueryData(queryKeys.project(anna.id, alpha.id, task.projectId))).toBeUndefined();
      await settle(); expect(ui.queryClient.getQueryState(queryKeys.workspace(anna.id, alpha.id))?.status).toBe('error');
      vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); vi.useRealTimers();
      expect(reads).toBe(1);
      const rootReadsBefore = rootReads;
      // These are TanStack's real automatic refetch triggers, with root GET already healthy.
      await act(async () => { focusManager.setFocused(false); onlineManager.setOnline(false); });
      await act(async () => { focusManager.setFocused(true); onlineManager.setOnline(true); });
      await settle();
      expect(rootReads).toBe(rootReadsBefore); expect(reads).toBe(1);
      expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
      await ui.user.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByRole('table'); await waitFor(() => expect(reads).toBe(2));
    } finally { vi.useRealTimers(); focusManager.setFocused(undefined); onlineManager.setOnline(true); ui.unmount(); ui.queryClient.clear(); }
  });

  it.each(['dirty draft', 'unknown command'] as const)('cancels a membership-triggered metadata root denial acquired before a protected %s', async protection => {
    const initialHead = deferred<Response>(); const rootRead = deferred<Response>(); const lost = lostResponse();
    let headReads = 0; let rootReads = 0; let writes = 0; let current = task;
    const replacementMember = 'c0000000-0000-4000-8000-000000000099';
    const api = installFakeApi({ ...tableRoutes(() => current),
      [`GET ${headPath}`]: () => ++headReads === 1 ? initialHead.promise : ok(head('5')),
      [`GET ${rootPath}`]: () => ++rootReads === 1 ? ok(alpha) : rootReads === 2 ? rootRead.promise : ok(alpha),
      [`GET ${rootPath}/tasks`]: () => ok([current]),
      [`PATCH ${rootPath}/tasks/${task.id}`]: request => ++writes === 1 ? lost.promise : ok(current = { ...task, title: (request.body as { title: string }).title, revision: 2 }),
    });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table');
      await waitFor(() => expect(ui.queryClient.getQueryData(queryKeys.memberships(anna.id, alpha.id))).toBeDefined());
      await act(async () => initialHead.resolve(ok({ ...head(), membershipId: replacementMember })));
      await waitFor(() => expect(rootReads).toBe(2));
      await ui.user.click(screen.getByRole('button', { name: task.title }));
      const input = screen.getByLabelText<HTMLInputElement>('Task name');
      fireEvent.change(input, { target: { value: 'Protected metadata race draft' } }); input.setSelectionRange(2, 6);
      if (protection === 'unknown command') {
        await ui.user.keyboard('{Control>}{Enter}{/Control}'); await waitFor(() => expect(writes).toBe(1));
        await act(async () => lost.lose()); await screen.findByRole('button', { name: 'Retry' });
      }
      const project = ui.queryClient.getQueryData(queryKeys.project(anna.id, alpha.id, task.projectId));
      await act(async () => rootRead.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Obsolete metadata denial'))); await settle();
      expect(screen.getByRole('table')).toBeInTheDocument(); expect(screen.getByLabelText('Task name')).toBe(input);
      expect(input).toHaveValue('Protected metadata race draft');
      expect(ui.queryClient.getQueryData(queryKeys.project(anna.id, alpha.id, task.projectId))).toBe(project);
      expect(ui.queryClient.getQueryState(queryKeys.workspace(anna.id, alpha.id))?.status).toBe('success');
      expect(headReads).toBe(1);
      if (protection === 'unknown command') {
        expect(protectedCommandsFor(ui.queryClient).protecting).toBe(true); expect(writes).toBe(1);
        const original = api.calls.find(call => call.method === 'PATCH');
        await ui.user.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(writes).toBe(2));
        const retry = api.calls.filter(call => call.method === 'PATCH')[1];
        expect(retry?.body).toEqual(original?.body); expect(retry?.headers.get('Idempotency-Key')).toBe(original?.headers.get('Idempotency-Key'));
      } else {
        expect(input).toHaveFocus(); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
        expect(protectedDraftsFor(ui.queryClient).protecting).toBe(true);
        fireEvent.change(input, { target: { value: task.title } }); await ui.user.keyboard('{Escape}');
      }
      await waitFor(() => expect(headReads).toBeGreaterThanOrEqual(2));
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });

  it('cancels a head-triggered me recheck so its late actor change cannot clear an actual unknown command', async () => {
    const initialHead = deferred<Response>(); const identity = deferred<Response>(); const lost = lostResponse();
    let headReads = 0; let meReads = 0; let writes = 0; let current = task;
    const api = installFakeApi({ ...tableRoutes(() => current),
      'GET /api/v1/me': () => ++meReads === 1 ? ok({ actor: anna, authMode: 'dev' }) : identity.promise,
      [`GET ${headPath}`]: () => ++headReads === 1 ? initialHead.promise : ok(head('8')),
      [`GET ${rootPath}/tasks`]: () => ok([current]),
      [`PATCH ${rootPath}/tasks/${task.id}`]: request => ++writes === 1 ? lost.promise : ok(current = { ...task, title: (request.body as { title: string }).title, revision: 2 }),
    });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await act(async () => initialHead.resolve(ok({ ...head(), actorUserId: boris.id })));
      await waitFor(() => expect(meReads).toBe(2));
      await ui.user.click(screen.getByRole('button', { name: task.title }));
      fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Protected identity race draft' } });
      await ui.user.keyboard('{Control>}{Enter}{/Control}'); await waitFor(() => expect(writes).toBe(1));
      await act(async () => lost.lose()); await screen.findByRole('button', { name: 'Retry' });
      const original = api.calls.find(call => call.method === 'PATCH');
      await act(async () => identity.resolve(ok({ actor: boris, authMode: 'dev' }))); await settle();
      expect(ui.queryClient.getQueryData<{ actor: { id: string } }>(queryKeys.me)?.actor.id).toBe(anna.id);
      expect(screen.getByRole('table')).toBeInTheDocument(); expect(screen.getByLabelText('Task name')).toHaveValue('Protected identity race draft');
      expect(protectedCommandsFor(ui.queryClient).protecting).toBe(true); expect(writes).toBe(1);
      await ui.user.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(writes).toBe(2));
      const retry = api.calls.filter(call => call.method === 'PATCH')[1];
      expect(retry?.body).toEqual(original?.body); expect(retry?.headers.get('Idempotency-Key')).toBe(original?.headers.get('Idempotency-Key'));
      await waitFor(() => expect(headReads).toBeGreaterThanOrEqual(2));
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });


  it('keeps the unavailable route and disabled retry feedback during an explicit access retry, including failure', async () => {
    const initialHead = deferred<Response>(); const failedRetry = deferred<Response>(); let rootReads = 0; let headReads = 0;
    installFakeApi({ ...tableRoutes(),
      [`GET ${headPath}`]: () => ++headReads === 1 ? initialHead.promise : ok(head('2')),
      [`GET ${rootPath}`]: () => ++rootReads === 3 ? failedRetry.promise : ok(alpha),
    });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await act(async () => initialHead.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Idle denial')));
      await screen.findByText('Workspace unavailable'); await waitFor(() => expect(rootReads).toBe(2));
      await ui.user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
      await act(async () => failedRetry.resolve(failure(503, 'UNAVAILABLE', 'Synthetic recovery outage')));
      await screen.findByRole('button', { name: 'Try again' }); expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
      expect(headReads).toBe(1);
      await ui.user.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByRole('table');
      await waitFor(() => expect(headReads).toBe(2));
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });


  it('offers explicit access recovery after departure removes the denied root and the same client returns', async () => {
    const initialHead = deferred<Response>(); let headReads = 0;
    installFakeApi({ ...tableRoutes(), [`GET ${headPath}`]: () => ++headReads === 1 ? initialHead.promise : ok(head('6')) });
    const ui = renderApp(tablePath);
    let returning: ReturnType<typeof render> | undefined;
    try {
      await screen.findByRole('table'); await act(async () => initialHead.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Idle denial')));
      await screen.findByRole('button', { name: 'Try again' }); ui.unmount();
      ui.queryClient.removeQueries({ queryKey: queryKeys.workspace(anna.id, alpha.id) });
      returning = render(<QueryClientProvider client={ui.queryClient}><MemoryRouter initialEntries={[tablePath]}>
        <SessionProvider><AppRoutes /></SessionProvider>
      </MemoryRouter></QueryClientProvider>);
      await screen.findByRole('button', { name: 'Try again' }); expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(headReads).toBe(1);
      await ui.user.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByRole('table'); await waitFor(() => expect(headReads).toBe(2));
    } finally { returning?.unmount(); ui.unmount(); ui.queryClient.clear(); }
  });


  it('checks current identity before manual head-denial recovery and never reloads old-actor content after a server actor switch', async () => {
    const initialHead = deferred<Response>(); let headReads = 0; let rootReads = 0; let actor = anna;
    const api = installFakeApi({ ...tableRoutes(),
      'GET /api/v1/me': () => ok({ actor, authMode: 'dev' }),
      [`GET ${rootPath}`]: () => { rootReads++; return ok(alpha); },
      [`GET ${headPath}`]: () => ++headReads === 1 ? initialHead.promise : ok(head('9')),
    });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await act(async () => initialHead.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Idle denial')));
      await screen.findByRole('button', { name: 'Try again' }); await waitFor(() => expect(rootReads).toBe(2));
      const contentReads = api.calls.filter(call => call.path === `${rootPath}/tasks`).length;
      const oldScopeReads: unknown[] = [];
      const unsubscribe = ui.queryClient.getQueryCache().subscribe(event => {
        if (event.type === 'updated' && event.action.type === 'fetch' && event.query.queryKey[0] === 'actor' &&
          event.query.queryKey[1] === anna.id && event.query.queryKey[2] === 'workspace' && event.query.queryKey[3] === alpha.id) {
          oldScopeReads.push(event.query.queryKey);
        }
      });
      actor = boris;
      await ui.user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(ui.queryClient.getQueryData<{ actor: { id: string } }>(queryKeys.me)?.actor.id).toBe(boris.id));
      await waitFor(() => expect(ui.queryClient.getQueryCache().findAll({ queryKey: queryKeys.actor(anna.id) })).toHaveLength(0));
      unsubscribe(); expect(oldScopeReads).toEqual([]);
      expect(api.calls.filter(call => call.path === `${rootPath}/tasks`)).toHaveLength(contentReads);
      expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });

  it('keeps neutral workspace recovery through a pending or failed identity check, then retries identity before the root', async () => {
    const initialHead = deferred<Response>(); const identity = deferred<Response>(); let headReads = 0; let meReads = 0; let rootReads = 0;
    installFakeApi({ ...tableRoutes(),
      'GET /api/v1/me': () => ++meReads === 2 ? identity.promise : ok({ actor: anna, authMode: 'dev' }),
      [`GET ${rootPath}`]: () => { rootReads++; return ok(alpha); },
      [`GET ${headPath}`]: () => ++headReads === 1 ? initialHead.promise : ok(head('4')),
    });
    const ui = renderApp(tablePath);
    try {
      await screen.findByRole('table'); await act(async () => initialHead.resolve(failure(403, 'CAPABILITY_REQUIRED', 'Idle denial')));
      await screen.findByRole('button', { name: 'Try again' }); await waitFor(() => expect(rootReads).toBe(2));
      await ui.user.click(screen.getByRole('button', { name: 'Try again' })); await waitFor(() => expect(meReads).toBe(2));
      expect(screen.getByText('Workspace unavailable')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
      expect(rootReads).toBe(2); expect(headReads).toBe(1);
      await act(async () => identity.resolve(failure(503, 'UNAVAILABLE', 'Synthetic identity outage')));
      await screen.findByRole('button', { name: 'Try again' }); expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
      expect(ui.queryClient.getQueryState(queryKeys.me)?.status).toBe('success'); expect(rootReads).toBe(2);
      await ui.user.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByRole('table');
      expect(meReads).toBe(3); await waitFor(() => expect(headReads).toBe(2));
    } finally { ui.unmount(); ui.queryClient.clear(); }
  });

});
