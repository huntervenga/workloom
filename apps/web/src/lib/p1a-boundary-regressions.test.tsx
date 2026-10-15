import { onlineManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { projectSchema, tagSchema, taskSchema, type ActorDto, type ProjectDto, type TagDto, type TaskDto } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionProvider, useSession } from '../app/session';
import { createProjectRequest, type ProjectList } from '../features/projects/api';
import { storeProject, useCreateProjectMutation, type CreateProjectVariables } from '../features/projects/queries';
import { storeTask, useUpdateTaskMutation, type UpdateTaskVariables } from '../features/tasks/queries';
import {
  alpha,
  alphaMembers,
  anna,
  beta,
  boris,
  created,
  deferred,
  failure,
  installFakeApi,
  ok,
  project,
} from '../test/fakeApi';
import { ApiError } from './api';
import { discardWorkspaceData } from './cacheScope';
import { isUuid } from './format';
import { UncertainCommandError } from './idempotency';
import { createQueryClient } from './queryClient';
import { queryKeys } from './queryKeys';
import { useIdempotentMutation } from './useIdempotentMutation';

/*
 * Regressions for P1a client safety boundaries. Each test drives the real hook, cache helper or
 * SessionProvider; only fetch is replaced, to stand in for the server and for lost transport.
 */

const PROJECT_ID = 'e0000000-0000-4000-8000-000000000001';
const STATUS_ID = 'e0000000-0000-4000-8000-000000000002';
const TASK_ID = 'e0000000-0000-4000-8000-000000000010';
const WORK_PACKAGE_ID = 'e0000000-0000-4000-8000-000000000020';
const TAG_ID = 'e0000000-0000-4000-8000-000000000030';
const CREATED_AT = '2026-10-01T09:00:00.000Z';
const LATER = '2026-10-02T12:00:00.000Z';
const projectsPath = `POST /api/v1/workspaces/${alpha.id}/projects`;

const clients: QueryClient[] = [];

afterEach(() => {
  // Drop paused or recorded writes before going back online, so nothing resumes into the next test.
  for (const client of clients.splice(0)) client.clear();
  onlineManager.setOnline(true);
});

function newClient(): QueryClient {
  const client = createQueryClient({ retry: false });
  clients.push(client);
  return client;
}

function providers(queryClient: QueryClient) {
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SessionProvider>{children}</SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

/** Lets timers, resumed mutations and notify batches run; used to show that nothing was sent. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((done) => setTimeout(done, 0));
  });
}

interface Send {
  /** Actor the server would resolve from the ambient session cookie at send time. */
  actorId: string;
  online: boolean;
  key: string | null;
  body: unknown;
}

/**
 * A server that resolves the actor from the ambient session, like the dev cookie. While
 * `online` is false the transport fails before any answer, as a dropped connection does.
 */
function ambientServer(initialActor: ActorDto) {
  const state = { actor: initialActor, online: true, answer: 'confirm' as 'confirm' | 'lose' | 'reject' };
  const sends: Send[] = [];
  const pending: { response: ReturnType<typeof deferred<Response>> | null } = { response: null };
  installFakeApi({
    [projectsPath]: (request) => {
      sends.push({
        actorId: state.actor.id,
        online: state.online,
        key: request.headers.get('Idempotency-Key'),
        body: request.body,
      });
      if (!state.online || state.answer === 'lose') throw new TypeError('Failed to fetch');
      if (state.answer === 'reject') return failure(400, 'VALIDATION_FAILED', 'Rejected');
      if (pending.response) return pending.response.promise;
      const { name } = request.body as { name: string };
      return created(project(alpha.id, PROJECT_ID, name));
    },
  });
  return { state, sends, pending };
}

function renderCreateProject(queryClient: QueryClient) {
  return renderHook(
    () => ({
      write: useIdempotentMutation({
        prepare: ({ input }: CreateProjectVariables) => createProjectRequest(alpha.id, input),
      }),
      session: useSession(),
    }),
    { wrapper: providers(queryClient) },
  );
}

describe('offline writes and the actor boundary', () => {
  it('attempts an offline write once, immediately, and keeps it as uncertain instead of pausing it', async () => {
    const server = ambientServer(anna);
    server.state.online = false;
    onlineManager.setOnline(false);
    const { result } = renderCreateProject(newClient());

    act(() => result.current.write.mutate({ input: { name: 'Офлайн' } }));

    await waitFor(() => expect(result.current.write.isError).toBe(true));
    expect(result.current.write.isPaused).toBe(false);
    expect(server.sends).toEqual([expect.objectContaining({ actorId: anna.id, online: false })]);
    expect(result.current.write.uncertain?.variables).toEqual({ input: { name: 'Офлайн' } });
    expect(result.current.write.error).toBeInstanceOf(ApiError);
  });

  it('never sends an actor A write by itself under actor B after reconnecting', async () => {
    const server = ambientServer(anna);
    server.state.online = false;
    onlineManager.setOnline(false);
    const { result } = renderCreateProject(newClient());

    act(() => result.current.write.mutate({ input: { name: 'Запись Анны' } }));
    await waitFor(() => expect(result.current.write.isPaused || result.current.write.isError).toBe(true));

    // Still offline, the session changes to Boris: the ambient identity the server will resolve.
    await act(() =>
      result.current.session.switchActor(() => {
        server.state.actor = boris;
        return Promise.resolve();
      }),
    );
    expect(result.current.session.switching).toBe(false);

    act(() => {
      server.state.online = true;
      onlineManager.setOnline(true);
    });
    await settle();

    expect(server.sends.filter((send) => send.actorId === boris.id)).toEqual([]);
    expect(server.sends.filter((send) => send.online)).toEqual([]);
    expect(server.sends.length).toBeLessThanOrEqual(1);
  });
});

describe('uncertain write with a changed payload', () => {
  it('refuses a different payload after reset and resends only the original body with its key', async () => {
    const server = ambientServer(anna);
    server.state.answer = 'lose';
    const { result } = renderCreateProject(newClient());

    act(() => result.current.write.mutate({ input: { name: '  Запуск  ' } }));
    await waitFor(() => expect(result.current.write.isError).toBe(true));
    expect(server.sends).toHaveLength(1);
    const [original] = server.sends;
    expect(original?.body).toEqual({ name: 'Запуск' });
    expect(isUuid(original?.key ?? '')).toBe(true);
    expect(result.current.write.uncertain?.variables).toEqual({ input: { name: '  Запуск  ' } });

    // Closing the form resets the mutation; the unknown outcome must survive it.
    act(() => result.current.write.reset());
    await waitFor(() => expect(result.current.write.isIdle).toBe(true));
    expect(result.current.write.uncertain).not.toBeNull();

    act(() => result.current.write.mutate({ input: { name: 'Другой проект' } }));
    await waitFor(() => expect(result.current.write.isError).toBe(true));
    expect(result.current.write.error).toBeInstanceOf(UncertainCommandError);
    expect(server.sends).toHaveLength(1);

    server.state.answer = 'confirm';
    act(() => result.current.write.retryUncertain());
    await waitFor(() => expect(result.current.write.isSuccess).toBe(true));

    expect(server.sends).toHaveLength(2);
    expect(server.sends[1]?.body).toEqual(original?.body);
    expect(server.sends[1]?.key).toBe(original?.key);
    expect(result.current.write.data).toEqual(projectSchema.parse(project(alpha.id, PROJECT_ID, 'Запуск')));
    expect(result.current.write.uncertain).toBeNull();

    // Once confirmed, the next operation is new and gets its own key.
    act(() => result.current.write.mutate({ input: { name: 'Другой проект' } }));
    await waitFor(() => expect(server.sends).toHaveLength(3));
    expect(server.sends[2]?.key).not.toBe(original?.key);
  });

  it('lets a different payload through with a new key after a confirmed rejection', async () => {
    const server = ambientServer(anna);
    server.state.answer = 'reject';
    const { result } = renderCreateProject(newClient());

    act(() => result.current.write.mutate({ input: { name: 'Отклонено' } }));
    await waitFor(() => expect(result.current.write.isError).toBe(true));
    expect(result.current.write.uncertain).toBeNull();

    server.state.answer = 'confirm';
    act(() => result.current.write.mutate({ input: { name: 'Исправлено' } }));
    await waitFor(() => expect(result.current.write.isSuccess).toBe(true));
    expect(server.sends.map((send) => send.body)).toEqual([{ name: 'Отклонено' }, { name: 'Исправлено' }]);
    expect(server.sends[1]?.key).not.toBe(server.sends[0]?.key);
  });
});

function tag(overrides: Partial<TagDto> = {}): TagDto {
  return tagSchema.parse({
    id: TAG_ID,
    workspaceId: alpha.id,
    name: 'Старое имя',
    color: '#3366ff',
    revision: 1,
    archivedAt: null,
    ...overrides,
  });
}

const [, vera, gleb] = alphaMembers;

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return taskSchema.parse({
    id: TASK_ID,
    workspaceId: alpha.id,
    projectId: PROJECT_ID,
    sectionId: null,
    parentTaskId: null,
    workPackageId: WORK_PACKAGE_ID,
    workPackageRevision: 2,
    title: 'Подготовить релиз',
    description: '',
    statusId: STATUS_ID,
    responsibleMembershipId: null,
    participants: [{ membershipId: vera?.id, role: 'assignee', active: true, revision: 1 }],
    participantsRevision: 2,
    dueDate: null,
    priority: 'medium',
    tags: [tag()],
    estimateMinutes: 120,
    revision: 3,
    position: 0,
    visibility: 'workspace',
    archivedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

describe('replayed task DTOs and independent revisions', () => {
  const taskKey = queryKeys.task(anna.id, alpha.id, TASK_ID);
  // An idempotent replay returns the task as first committed; colleagues have changed parts since.
  const replay = task();

  it.each([
    {
      part: 'shared work package estimate',
      cached: task({ workPackageRevision: 3, estimateMinutes: 240, updatedAt: LATER }),
    },
    {
      part: 'participant set',
      cached: task({
        participantsRevision: 3,
        participants: [
          { membershipId: vera?.id ?? '', role: 'assignee', active: false, revision: 2 },
          { membershipId: gleb?.id ?? '', role: 'assignee', active: true, revision: 1 },
        ],
        updatedAt: LATER,
      }),
    },
    {
      part: 'embedded tag (renamed and archived)',
      cached: task({ tags: [tag({ name: 'Новое имя', revision: 2, archivedAt: LATER })] }),
    },
  ])('keeps the newer cached $part when a replay repeats the task revision', async ({ cached }) => {
    expect(replay.revision).toBe(cached.revision);
    const queryClient = newClient();
    queryClient.setQueryData(taskKey, cached);

    await storeTask(queryClient, anna.id, alpha.id, replay);

    expect(queryClient.getQueryData(taskKey)).toEqual(cached);
  });

  it('applies a replayed task that is newer in every part', async () => {
    const queryClient = newClient();
    queryClient.setQueryData(taskKey, replay);
    const newer = task({
      revision: 4,
      workPackageRevision: 3,
      participantsRevision: 3,
      tags: [tag({ name: 'Новое имя', revision: 2 })],
      updatedAt: LATER,
    });

    await storeTask(queryClient, anna.id, alpha.id, newer);

    expect(queryClient.getQueryData(taskKey)).toEqual(newer);
  });
});

describe('one command at a time per write hook', () => {
  const TASK_B_ID = 'e0000000-0000-4000-8000-000000000011';
  const WORK_PACKAGE_B_ID = 'e0000000-0000-4000-8000-000000000021';
  const taskPathA = `/api/v1/workspaces/${alpha.id}/tasks/${TASK_ID}`;
  const taskPathB = `/api/v1/workspaces/${alpha.id}/tasks/${TASK_B_ID}`;
  const commandA: UpdateTaskVariables = { taskId: TASK_ID, input: { expectedRevision: 3, title: '  Задача А  ' } };
  const commandB: UpdateTaskVariables = { taskId: TASK_B_ID, input: { expectedRevision: 1, title: 'Задача Б' } };

  it('refuses another target while a write is in flight and keeps the lost one with its key', async () => {
    const gate = deferred<undefined>();
    const sends: { path: string; key: string | null; body: unknown }[] = [];
    const confirmedA = task({ title: 'Задача А', revision: 4, updatedAt: LATER });
    installFakeApi({
      [`PATCH ${taskPathA}`]: async (request) => {
        sends.push({ path: request.path, key: request.headers.get('Idempotency-Key'), body: request.body });
        if (sends.filter((send) => send.path === taskPathA).length > 1) return ok(confirmedA);
        // The first answer is held, then lost in transport.
        await gate.promise;
        throw new TypeError('Failed to fetch');
      },
      // Would succeed if wrongly sent, so a leak of B is observable.
      [`PATCH ${taskPathB}`]: (request) => {
        sends.push({ path: request.path, key: request.headers.get('Idempotency-Key'), body: request.body });
        return ok(task({ id: TASK_B_ID, workPackageId: WORK_PACKAGE_B_ID, title: 'Задача Б', revision: 2 }));
      },
    });
    const sendsTo = (path: string) => sends.filter((send) => send.path === path);
    const outcomesB: unknown[] = [];
    const recordB = { onError: (error: Error) => outcomesB.push(error), onSuccess: (data: TaskDto) => outcomesB.push(data) };
    const { result } = renderHook(() => useUpdateTaskMutation(anna.id, alpha.id), { wrapper: providers(newClient()) });

    try {
      act(() => result.current.mutate(commandA));
      await waitFor(() => expect(sendsTo(taskPathA)).toHaveLength(1));
      const [firstA] = sends;
      expect(firstA?.body).toEqual({ expectedRevision: 3, title: 'Задача А' });
      expect(isUuid(firstA?.key ?? '')).toBe(true);
      expect(result.current.isSuccess).toBe(false);

      // A has no answer yet: the same hook must not send B, to another task with another body.
      act(() => result.current.mutate(commandB, recordB));
      await settle();
      expect(sendsTo(taskPathB)).toEqual([]);

      gate.resolve(undefined);
      await waitFor(() => expect(result.current.uncertain?.variables).toEqual(commandA));
      await settle();
      expect(result.current.uncertain?.variables).toEqual(commandA);

      // B is still refused now that A's outcome is known to be uncertain, and A stays remembered.
      act(() => result.current.mutate(commandB, recordB));
      await waitFor(() => expect(outcomesB.at(-1)).toBeInstanceOf(UncertainCommandError));
      expect(result.current.uncertain?.variables).toEqual(commandA);
      expect(sendsTo(taskPathB)).toEqual([]);

      act(() => result.current.retryUncertain());
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(sendsTo(taskPathA)).toHaveLength(2);
      expect(sendsTo(taskPathA)[1]).toEqual(firstA);
      expect(result.current.data).toEqual(confirmedA);
      expect(result.current.uncertain).toBeNull();
      expect(sendsTo(taskPathB)).toEqual([]);
    } finally {
      gate.resolve(undefined);
    }
  });
});

describe('replayed project absent from the current list', () => {
  it('does not put an archived project back into the active list from an older replay', async () => {
    const queryClient = newClient();
    const archived: ProjectDto = projectSchema.parse({
      ...project(alpha.id, PROJECT_ID, 'Архивный проект', 2),
      archivedAt: LATER,
      updatedAt: LATER,
    });
    const replayed: ProjectDto = projectSchema.parse(project(alpha.id, PROJECT_ID, 'Архивный проект', 1));
    const listKey = queryKeys.projectList(anna.id, alpha.id);
    const detailKey = queryKeys.project(anna.id, alpha.id, PROJECT_ID);
    queryClient.setQueryData(detailKey, archived);
    // A newer refetch of active projects no longer contains it.
    queryClient.setQueryData<ProjectList>(listKey, { projects: [], nextCursor: null });

    await storeProject(queryClient, anna.id, alpha.id, replayed);

    expect(queryClient.getQueryData(detailKey)).toEqual(archived);
    expect(queryClient.getQueryData<ProjectList>(listKey)?.projects).toEqual([]);
  });
});

describe('discarding session and workspace data', () => {
  function seed(queryClient: QueryClient) {
    queryClient.setQueryData(queryKeys.devActors, [anna, boris]);
    queryClient.setQueryData(queryKeys.workspaces(anna.id), [alpha, beta]);
    queryClient.setQueryData<ProjectList>(queryKeys.projectList(anna.id, alpha.id), { projects: [], nextCursor: null });
    queryClient.setQueryData<ProjectList>(queryKeys.projectList(anna.id, beta.id), { projects: [], nextCursor: null });
    queryClient.setQueryData(queryKeys.task(anna.id, alpha.id, TASK_ID), task());
  }

  function renderSessionWrite(queryClient: QueryClient) {
    return renderHook(
      () => ({ write: useCreateProjectMutation(anna.id, alpha.id), session: useSession() }),
      { wrapper: providers(queryClient) },
    );
  }

  const actorQueries = (queryClient: QueryClient, actorId: string) =>
    queryClient.getQueryCache().findAll({ queryKey: queryKeys.actor(actorId) });

  it('drops the previous actor’s recorded writes as well as its queries on an actor switch', async () => {
    const server = ambientServer(anna);
    const queryClient = newClient();
    seed(queryClient);
    const { result } = renderSessionWrite(queryClient);

    act(() => result.current.write.mutate({ input: { name: 'Проект Анны' } }));
    await waitFor(() => expect(result.current.write.isSuccess).toBe(true));
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    await act(() =>
      result.current.session.switchActor(() => {
        server.state.actor = boris;
        return Promise.resolve();
      }),
    );

    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(actorQueries(queryClient, anna.id)).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.devActors)).toEqual([anna, boris]);
  });

  it('does not let a late answer to the previous actor’s write recreate its discarded cache', async () => {
    const server = ambientServer(anna);
    const response = deferred<Response>();
    server.pending.response = response;
    const queryClient = newClient();
    seed(queryClient);
    const { result } = renderSessionWrite(queryClient);

    act(() => result.current.write.mutate({ input: { name: 'Поздний ответ' } }));
    await waitFor(() => expect(server.sends).toHaveLength(1));

    await act(() =>
      result.current.session.switchActor(() => {
        server.state.actor = boris;
        return Promise.resolve();
      }),
    );
    response.resolve(created(project(alpha.id, PROJECT_ID, 'Поздний ответ')));
    await settle();
    await storeTask(queryClient, anna.id, alpha.id, task({ revision: 9 }));

    expect(actorQueries(queryClient, anna.id)).toEqual([]);
    expect(server.sends).toHaveLength(1);
  });

  it('drops the left workspace’s queries and every recorded write, keeping other workspaces', async () => {
    ambientServer(anna);
    const queryClient = newClient();
    seed(queryClient);
    const { result } = renderSessionWrite(queryClient);

    act(() => result.current.write.mutate({ input: { name: 'Проект в Альфе' } }));
    await waitFor(() => expect(result.current.write.isSuccess).toBe(true));
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    await discardWorkspaceData(queryClient, anna.id, alpha.id);

    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.workspace(anna.id, alpha.id) })).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.projectList(anna.id, beta.id))).toEqual({ projects: [], nextCursor: null });
    expect(queryClient.getQueryData(queryKeys.workspaces(anna.id))).toEqual([alpha, beta]);

    // Late answers for the left workspace only touch entries that are still cached.
    await storeProject(queryClient, anna.id, alpha.id, project(alpha.id, PROJECT_ID, 'Поздний', 3));
    await storeTask(queryClient, anna.id, alpha.id, task({ revision: 9 }));
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.workspace(anna.id, alpha.id) })).toEqual([]);
  });
});
