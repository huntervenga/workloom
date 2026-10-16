import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { GraphLayoutDto, SetGraphLayoutInput } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { isUuid } from '../../lib/format';
import { PendingCommandError, UncertainCommandError } from '../../lib/idempotency';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, created, deferred, failure, installFakeApi, ok, project, type FakeRequest } from '../../test/fakeApi';
import { GraphView } from './GraphView';
import { DependencyPanel } from './DependencyPanel';
import { dependencyKeys, useGraphQuery, type EdgeCreateVariables } from './queries';
import { blocking, edge, graph, layout, PROJECT_ID, rootPath, taskAt } from './test/fixtures';
import { useDependencyWorkspace, type DependencyWorkspace } from './useDependencyWorkspace';

// Actual QueryClient/controller/GraphView; only fetch is replaced to delay or lose real hook responses.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
function providers() {
  const client = createQueryClient({ retry: false }); clients.push(client);
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function workspace() {
  const { client, Wrapper } = providers();
  return { ...renderHook(() => useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID), { wrapper: Wrapper }), client };
}
const edgePath = `${rootPath}/dependencies`;
const projectPath = `${rootPath}/projects/${PROJECT_ID}`;
const layoutPath = `${projectPath}/graph-layout`;
function edgeVariables(c: DependencyWorkspace, anchorId: string): EdgeCreateVariables {
  const draft = c.drafts[anchorId];
  if (!draft?.other) throw new Error('Expected a completed edge draft.');
  return { draftId: draft.id, anchorTaskId: anchorId, input: { predecessorTaskId: draft.direction === 'incoming' ? draft.other.id : anchorId, successorTaskId: draft.direction === 'incoming' ? anchorId : draft.other.id, type: 'finish_to_start', expectedAbsent: true } };
}
function currentLayout(c: DependencyWorkspace): SetGraphLayoutInput {
  if (c.layoutInput === null) throw new Error('Expected a loaded layout.');
  return c.layoutInput;
}
function exactRetry(requests: FakeRequest[], method: string, path: string, input: unknown) {
  expect(requests).toHaveLength(2);
  const key = requests[0]?.headers.get('Idempotency-Key') ?? '';
  expect(isUuid(key)).toBe(true);
  for (const request of requests) {
    expect(request.method).toBe(method); expect(request.path).toBe(path);
    expect(request.headers.get('Idempotency-Key')).toBe(key); expect(request.body).toEqual(input);
  }
}

describe('dependency command boundaries', () => {
  it('keeps lost edge A and its key while draft B remains typed, then global retry retires only A', async () => {
    const lost = deferred<undefined>(); let sends = 0;
    const a = taskAt(1), b = taskAt(2), predecessor = taskAt(3);
    const saved = edge(predecessor.id, a.id);
    const { calls } = installFakeApi({ [`POST ${edgePath}`]: async () => {
      sends += 1; if (sends === 1) { await lost.promise; throw new TypeError('Failed to fetch'); }
      return created(saved);
    } });
    const view = workspace();
    act(() => view.result.current.openCreate(a, predecessor));
    const commandA = edgeVariables(view.result.current, a.id);
    act(() => view.result.current.commands.create.mutate(commandA));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => view.result.current.openCreate(b, predecessor));
    const draftB = view.result.current.drafts[b.id];
    if (!draftB) throw new Error('Expected B draft.');
    act(() => view.result.current.changeDraft(draftB.id, { search: 'Retained B input' }));
    let refused: unknown;
    await act(async () => { refused = await view.result.current.commands.create.mutateAsync(edgeVariables(view.result.current, b.id)).catch(error => error); });
    expect(refused).toBeInstanceOf(PendingCommandError);
    expect(calls).toHaveLength(1);
    await act(async () => { lost.resolve(undefined); });
    await waitFor(() => expect(view.result.current.commands.create.uncertain?.variables.draftId).toBe(commandA.draftId));
    await act(async () => { refused = await view.result.current.commands.create.mutateAsync(edgeVariables(view.result.current, b.id)).catch(error => error); });
    expect(refused).toBeInstanceOf(UncertainCommandError);
    expect(calls).toHaveLength(1);
    act(() => view.result.current.commands.create.retryUncertain());
    await waitFor(() => expect(view.result.current.commands.create.uncertain).toBeNull());
    await waitFor(() => expect(view.result.current.drafts[a.id]).toBeUndefined());
    expect(view.result.current.drafts[b.id]).toMatchObject({ id: draftB.id, search: 'Retained B input' });
    expect(view.result.current.activeAnchor).toBe(b.id);
    exactRetry(calls, 'POST', edgePath, commandA.input);
  });

  it('submits the entire personal layout including hidden positions and retries its original revision after response loss', async () => {
    const lost = deferred<undefined>(); let sends = 0;
    const a = taskAt(1), hidden = taskAt(2);
    const positions = [{ taskId: a.id, x: 0, y: 0 }, { taskId: hidden.id, x: 70, y: 80 }];
    const submitted = [{ taskId: a.id, x: 12, y: 24 }, { taskId: hidden.id, x: 70, y: 80 }];
    const { calls } = installFakeApi({ [`PUT ${layoutPath}`]: async () => {
      sends += 1; if (sends === 1) { await lost.promise; throw new TypeError('Failed to fetch'); }
      return ok(layout(submitted, 4));
    } });
    const view = workspace();
    act(() => view.result.current.adoptLayout(layout(positions, 3)));
    act(() => { view.result.current.setRoots([a.id]); view.result.current.move(a.id, { x: 12, y: 24 }); });
    const input = currentLayout(view.result.current);
    expect(input).toEqual({ expectedRevision: 3, positions: submitted });
    act(() => view.result.current.commands.layout.mutate({ input }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => { view.result.current.setRoots([hidden.id]); view.result.current.setDepth(2); view.result.current.move(hidden.id, { x: 999, y: 999 }); view.result.current.discardLayout(); });
    expect(currentLayout(view.result.current)).toEqual(input);
    await act(async () => { lost.resolve(undefined); });
    await waitFor(() => expect(view.result.current.commands.layout.uncertain).not.toBeNull());
    act(() => view.result.current.resetLayout());
    expect(currentLayout(view.result.current)).toEqual(input);
    act(() => view.result.current.commands.layout.retryUncertain());
    await waitFor(() => expect(view.result.current.layout.base?.revision).toBe(4));
    expect(view.result.current.layoutDirty).toBe(false);
    expect(currentLayout(view.result.current).positions).toEqual(submitted);
    exactRetry(calls, 'PUT', layoutPath, input);
  });

  it('rebases a confirmed revision conflict without discarding visible moves or new hidden saved positions', async () => {
    const a = taskAt(1), hidden = taskAt(2);
    const { calls } = installFakeApi({ [`PUT ${layoutPath}`]: () => failure(409, 'REVISION_CONFLICT', 'Changed in another tab') });
    const view = workspace();
    act(() => view.result.current.adoptLayout(layout([{ taskId: a.id, x: 1, y: 1 }, { taskId: hidden.id, x: 2, y: 2 }], 3)));
    act(() => view.result.current.move(a.id, { x: 10, y: 20 }));
    act(() => view.result.current.commands.layout.mutate({ input: currentLayout(view.result.current) }));
    await waitFor(() => expect(view.result.current.commands.layout.error).not.toBeNull());
    expect(view.result.current.commands.layout.uncertain).toBeNull();
    act(() => view.result.current.rebaseLayout(layout([{ taskId: a.id, x: 8, y: 8 }, { taskId: hidden.id, x: 90, y: 91 }], 7)));
    expect(currentLayout(view.result.current)).toEqual({ expectedRevision: 7, positions: [{ taskId: a.id, x: 10, y: 20 }, { taskId: hidden.id, x: 90, y: 91 }] });
    expect(calls).toHaveLength(1);
  });

  it('does not regress independent task/package/participant versions from an older graph response', async () => {
    const a = { ...taskAt(1), revision: 8, workPackageRevision: 5, participantsRevision: 7 };
    const older = { ...a, revision: 2, workPackageRevision: 1, participantsRevision: 1 };
    installFakeApi({ [`GET ${projectPath}/graph`]: () => ok(graph([older], [a.id], [], '9007199254740993')) });
    const { client, Wrapper } = providers();
    const current = graph([a], [a.id], [], '9007199254740997');
    const key = dependencyKeys.graph(anna.id, alpha.id, PROJECT_ID, [a.id], 1);
    client.setQueryData(key, current);
    const view = renderHook(() => useGraphQuery(anna.id, alpha.id, PROJECT_ID, [a.id], 1), { wrapper: Wrapper });
    await act(async () => { await view.result.current.refetch(); });
    expect(view.result.current.data).toEqual(current);
    expect(view.result.current.data?.nodes[0]?.task).toMatchObject({ revision: 8, workPackageRevision: 5, participantsRevision: 7 });
  });
});

function graphHost(layoutRead: () => Response | Promise<Response>, layoutWrite: () => Response | Promise<Response>, graphRead: () => Response | Promise<Response> = () => ok(graph([taskAt(1)])), options: { card?: boolean; edgeWrite?: () => Response; readDenied?: () => boolean } = {}) {
  const a = taskAt(1);
  const { client, Wrapper } = providers();
  const { calls } = installFakeApi({
    [`GET ${layoutPath}`]: layoutRead, [`PUT ${layoutPath}`]: layoutWrite,
    [`POST ${edgePath}`]: options.edgeWrite ?? (() => created(edge())),
    [`PATCH ${edgePath}/${edge().id}`]: options.edgeWrite ?? (() => ok(edge())),
    [`GET ${rootPath}/tasks/${a.id}/blocking`]: () => options.readDenied?.() ? failure(403, 'CAPABILITY_REQUIRED', 'Current read denied') : ok(blocking(a, taskAt(2))),
    [`GET ${edgePath}`]: () => ok([]),
    [`GET ${projectPath}/graph`]: graphRead,
    [`GET ${projectPath}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }),
  });
  let latest: DependencyWorkspace | undefined;
  const current = () => { if (!latest) throw new Error('Expected mounted graph controller.'); return latest; };
  function Host() {
    const controller = useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID); latest = controller;
    return <MemoryRouter>{options.card ? <DependencyPanel actorId={anna.id} workspaceId={alpha.id} project={project(alpha.id, PROJECT_ID, 'Project')} task={a} controller={controller} writable onOpenTask={() => undefined} /> : <GraphView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} controller={controller} loadedTasks={[a]} onOpen={() => undefined} />}</MemoryRouter>;
  }
  const view = render(<Host />, { wrapper: Wrapper });
  act(() => { current().setCanvas(false); current().setRoots([a.id]); });
  return { ...view, client, calls, current };
}

describe('mounted graph response boundaries', () => {
  it('keeps a newer cached personal layout after the original save response arrives late', async () => {
    const a = taskAt(1), hidden = taskAt(2), answer = deferred<Response>();
    let remote: GraphLayoutDto = layout([{ taskId: a.id, x: 0, y: 0 }, { taskId: hidden.id, x: 1, y: 1 }], 3);
    const view = graphHost(() => ok(remote), () => answer.promise);
    await waitFor(() => expect(view.current().layout.base?.revision).toBe(3));
    act(() => view.current().move(a.id, { x: 10, y: 20 }));
    act(() => view.current().commands.layout.mutate({ input: currentLayout(view.current()) }));
    await waitFor(() => expect(view.calls.filter(call => call.method === 'PUT')).toHaveLength(1));
    remote = layout([{ taskId: a.id, x: 90, y: 91 }, { taskId: hidden.id, x: 92, y: 93 }], 9);
    await act(async () => { await view.client.invalidateQueries({ queryKey: dependencyKeys.layout(anna.id, alpha.id, PROJECT_ID), exact: true }); });
    expect(view.client.getQueryData<GraphLayoutDto>(dependencyKeys.layout(anna.id, alpha.id, PROJECT_ID))?.revision).toBe(9);
    expect(view.current().layout.moves[a.id]).toEqual({ x: 10, y: 20 });
    await act(async () => { answer.resolve(ok(layout([{ taskId: a.id, x: 10, y: 20 }, { taskId: hidden.id, x: 1, y: 1 }], 4))); });
    await waitFor(() => expect(view.current().commands.layout.pendingCommand).toBeNull());
    await waitFor(() => expect(view.current().layout.base?.revision).toBe(9));
    expect(currentLayout(view.current()).positions).toEqual(remote.positions);
  });

  it('hides cached graph content on current denial while retaining the page-owned unsent coordinates', async () => {
    let denied = false;
    const a = taskAt(1);
    const view = graphHost(() => ok(layout([{ taskId: a.id, x: 0, y: 0 }], 2)), () => failure(500, 'UNEXPECTED_WRITE', 'No save expected'), () => denied ? failure(403, 'CAPABILITY_REQUIRED', 'Denied') : ok(graph([a])));
    await waitFor(() => expect(screen.getByRole('button', { name: a.title })).toBeInTheDocument());
    act(() => view.current().move(a.id, { x: 10, y: 20 }));
    denied = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: dependencyKeys.graph(anna.id, alpha.id, PROJECT_ID, [a.id], 1), exact: true }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: a.title })).not.toBeInTheDocument());
    expect(view.current().layout.moves[a.id]).toEqual({ x: 10, y: 20 });
    expect(view.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
});


describe('current edge-write denial over cached reads', () => {
  for (const card of [false, true]) {
    for (const command of ['create', 'update'] as const) {
      it(`hides the cached ${card ? 'task card' : 'graph'} after ${command} is denied and preserves the unsent draft`, async () => {
        const a = taskAt(1), predecessor = taskAt(2);
        let readDenied = false;
        const view = graphHost(() => ok(layout()), () => ok(layout()), () => readDenied ? failure(403, 'CAPABILITY_REQUIRED', 'Current read denied') : ok(graph([a, predecessor], [a.id])), { card, readDenied: () => readDenied, edgeWrite: () => failure(403, 'CAPABILITY_REQUIRED', 'Current access denied') });
        const label = card ? predecessor.title : a.title;
        await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeInTheDocument());
        act(() => view.current().openCreate(a, predecessor));
        const variables = edgeVariables(view.current(), a.id);
        if (command === 'create') act(() => view.current().commands.create.mutate(variables));
        else act(() => view.current().commands.update.mutate({ anchorTaskId: a.id, edge: edge(predecessor.id, a.id), input: { expectedRevision: 1, state: 'removed' } }));
        await waitFor(() => expect(view.current().commands[command].error).not.toBeNull());
        await waitFor(() => expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument());
        expect(view.current().drafts[a.id]?.id).toBe(variables.draftId);
        const recovery = card ? "Check dependency access" : "Check graph access";
        readDenied = true;
        fireEvent.click(screen.getByRole('button', { name: recovery }));
        await waitFor(() => expect(view.calls.filter(call => call.method === 'GET' && call.path === (card ? `${rootPath}/tasks/${a.id}/blocking` : `${projectPath}/graph`)).length).toBeGreaterThan(1));
        await waitFor(() => expect(screen.getByRole('button', { name: recovery })).toBeEnabled());
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
        readDenied = false;
        fireEvent.click(screen.getByRole('button', { name: recovery }));
        await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeInTheDocument());
        expect(view.current().drafts[a.id]?.id).toBe(variables.draftId);
        expect(view.calls.filter(call => call.method === (command === 'create' ? 'POST' : 'PATCH'))).toHaveLength(1);
      });
    }
  }
});
