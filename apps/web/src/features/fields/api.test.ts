import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, created, failure, installFakeApi, json, ok } from '../../test/fakeApi';
import {
  useCreateTaskFieldMutation,
  useProjectFieldValuesQuery,
  useSetTaskFieldValueMutation,
  useTaskFieldHistoryQuery,
  useTaskFieldsQuery,
} from './queries';

const leakyMessage = 'field locked: update task_field_values set ... -- postgres://admin:s3cret@db';
const projectId = 'e0000000-0000-4000-8000-000000000001';
const taskId = 'f0000000-0000-4000-8000-000000000001';
const fieldId = '90000000-0000-4000-8000-000000000001';
const versionId = '90000000-0000-4000-8000-0000000000aa';
const key = '0b6a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d';
const valuePath = `/api/v1/workspaces/${alpha.id}/tasks/${taskId}/field-values/${fieldId}`;
const stamp = '2026-10-01T09:00:00.000Z';

function valueRow(forTask: string, revision = 1): TaskFieldValueDto {
  return {
    workspaceId: alpha.id,
    projectId,
    taskId: forTask,
    fieldId,
    definitionVersionId: versionId,
    revision,
    value: { type: 'person', value: [] },
    updatedAt: stamp,
  };
}

const personField: TaskFieldDefinitionDto = {
  id: fieldId,
  workspaceId: alpha.id,
  projectId,
  name: 'Ответственные',
  type: 'person',
  revision: 3,
  definitionVersionId: versionId,
  historyEnabled: true,
  locked: false,
  archivedAt: null,
  options: [],
  createdAt: stamp,
  updatedAt: stamp,
};

function setup() {
  const queryClient = createQueryClient({ retry: false });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

/** Like `installFakeApi`, but keeps the query string, which batch and history requests carry. */
function stubFetch(handler: (url: URL) => Response) {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://127.0.0.1:4311');
      urls.push(url);
      return handler(url);
    }),
  );
  return urls;
}

describe('useSetTaskFieldValueMutation', () => {
  it('sends one PUT with the canonical strict body, both revisions and the key, then only invalidates', async () => {
    const { calls } = installFakeApi({ [`PUT ${valuePath}`]: () => ok(valueRow(taskId, 5)) });
    const { queryClient, wrapper } = setup();
    const valuesKey = queryKeys.taskFieldValues(anna.id, alpha.id, taskId);
    const historyKey = queryKeys.taskFieldHistory(anna.id, alpha.id, taskId, fieldId);
    queryClient.setQueryData(valuesKey, [valueRow(taskId, 6)]);
    queryClient.setQueryData(historyKey, { pages: [], pageParams: [] });
    const { result } = renderHook(() => useSetTaskFieldValueMutation(anna.id, alpha.id), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        taskId,
        fieldId,
        idempotencyKey: key,
        input: {
          expectedRevision: 4,
          expectedDefinitionRevision: 3,
          value: { type: 'person', value: ['C0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001'] },
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      credentials: 'same-origin',
      body: {
        expectedRevision: 4,
        expectedDefinitionRevision: 3,
        value: { type: 'person', value: ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003'] },
      },
    });
    expect(calls[0]?.headers.get('idempotency-key')).toBe(key);
    expect([...(calls[0]?.headers.keys() ?? [])].filter((name) => /actor|x-workloom/i.test(name))).toEqual([]);

    // A replayed answer (revision 5) must not overwrite newer cached data (revision 6).
    expect(queryClient.getQueryData(valuesKey)).toEqual([valueRow(taskId, 6)]);
    expect(queryClient.getQueryState(valuesKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
    // Batches that were never cached are not created.
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.projectFieldValues(anna.id, alpha.id, projectId) })).toEqual([]);
  });

  it('sends nothing for input the strict schema rejects', async () => {
    const { calls } = installFakeApi({ [`PUT ${valuePath}`]: () => ok(valueRow(taskId)) });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSetTaskFieldValueMutation(anna.id, alpha.id), { wrapper });
    const send = (input: unknown) =>
      result.current.mutateAsync({ taskId, fieldId, input: input as never }).then(
        () => null,
        (error: unknown) => error,
      );
    const person = 'c0000000-0000-4000-8000-000000000001';

    const errors = [
      await send({ expectedRevision: 0, expectedDefinitionRevision: 0, value: { type: 'person', value: null } }),
      await send({ expectedRevision: -1, expectedDefinitionRevision: 1, value: { type: 'boolean', value: false } }),
      await send({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'person', value: [person, person] } }),
      await send({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'duration', value: 1.5 } }),
      await send({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'url', value: 'javascript:alert(1)' } }),
      await send({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'text', value: 'x' }, actorId: anna.id }),
    ];

    expect(errors.map((error) => (error instanceof ApiError ? error.kind : error))).toEqual(Array(6).fill('invalid_input'));
    expect(calls).toHaveLength(0);
  });

  it('describes a locked field with fixed copy and no retry, keeping no server text', async () => {
    installFakeApi({ [`PUT ${valuePath}`]: () => failure(409, 'FIELD_LOCKED', leakyMessage) });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSetTaskFieldValueMutation(anna.id, alpha.id), { wrapper });

    const error: unknown = await result.current
      .mutateAsync({
        taskId,
        fieldId,
        input: { expectedRevision: 1, expectedDefinitionRevision: 3, value: { type: 'person', value: null } },
      })
      .catch((caught: unknown) => caught);

    const described = describeError(error, 'fieldValueSave');
    expect(described).toMatchObject({ title: 'Не удалось сохранить значение поля', retryable: false, requestId: 'req_test_err' });
    expect(described.description).toContain('заблокировано');
    expect(`${described.title} ${described.description}`).not.toMatch(/s3cret|update|postgres/);
  });
});

describe('field query keys', () => {
  it('refetches fields read with a mixed-case project ID after a write answers with the lowercase ID', async () => {
    const fieldsPath = `/api/v1/workspaces/${alpha.id}/fields`;
    const textField: TaskFieldDefinitionDto = { ...personField, type: 'text', name: 'Заметка' };
    let stored: TaskFieldDefinitionDto[] = [];
    const { calls } = installFakeApi({
      [`GET ${fieldsPath}`]: () => ok(stored),
      [`POST ${fieldsPath}`]: () => {
        stored = [textField];
        return created(textField);
      },
    });
    const { wrapper } = setup();
    const mixedCase = projectId.toUpperCase();

    const { result } = renderHook(
      () => ({
        fields: useTaskFieldsQuery(anna.id, alpha.id, mixedCase),
        create: useCreateTaskFieldMutation(anna.id, alpha.id),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.fields.data).toEqual([]));
    await act(() =>
      result.current.create.mutateAsync({ idempotencyKey: key, input: { projectId: mixedCase, name: 'Заметка', type: 'text', historyEnabled: true, locked: false, options: [] } }),
    );
    await waitFor(() => expect(result.current.fields.data).toEqual([textField]));

    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[1]?.body).toMatchObject({ projectId });
  });
});

describe('useProjectFieldValuesQuery', () => {
  const batchPath = `/api/v1/workspaces/${alpha.id}/projects/${projectId}/field-values`;
  const taskIdAt = (index: number) => `f0000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

  it('loads more than 200 tasks in canonical batches of at most 200 and aggregates them', async () => {
    const urls = stubFetch((url) =>
      url.pathname === batchPath ? ok((url.searchParams.get('taskIds') ?? '').split(',').map((id) => valueRow(id))) : failure(404, 'NOT_FOUND', ''),
    );
    const ids = Array.from({ length: 401 }, (_, index) => taskIdAt(index + 1));
    // Duplicates, uppercase and malformed IDs collapse into the same 401 tasks.
    const loaded = [...ids].reverse().concat(taskIdAt(1).toUpperCase(), taskIdAt(2), 'not-a-uuid');
    const { wrapper } = setup();

    const { result } = renderHook(() => useProjectFieldValuesQuery(anna.id, alpha.id, projectId, loaded), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const batches = urls.map((url) => (url.searchParams.get('taskIds') ?? '').split(','));
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 1]);
    expect(batches.flat()).toEqual(ids);
    expect(result.current).toMatchObject({ isError: false, error: null });
    expect(result.current.data.map((value) => value.taskId)).toEqual(ids);
  });

  it('requests nothing and is not pending without tasks', () => {
    const urls = stubFetch(() => ok([]));
    const { wrapper } = setup();

    const { result } = renderHook(() => useProjectFieldValuesQuery(anna.id, alpha.id, projectId, []), { wrapper });

    expect(result.current).toMatchObject({ data: [], isPending: false, isFetching: false, isError: false, error: null });
    expect(urls).toHaveLength(0);
  });
});

describe('useTaskFieldHistoryQuery', () => {
  it('follows meta.nextCursor with the default limit and stops when it is absent', async () => {
    const historyPath = `${valuePath}/history`;
    const entry = {
      id: '70000000-0000-4000-8000-000000000001',
      workspaceId: alpha.id,
      projectId,
      taskId,
      fieldId,
      valueRevision: 1,
      definition: personField,
      before: null,
      after: { type: 'person', value: null },
      actor: { id: anna.id, displayName: anna.displayName },
      source: 'web',
      recordedAt: stamp,
      changeSeq: '9007199254740993',
      eventOrdinal: 1,
    };
    const urls = stubFetch((url) => {
      if (url.pathname !== historyPath) return failure(404, 'NOT_FOUND', '');
      return url.searchParams.get('cursor') === 'page-2'
        ? ok([])
        : json(200, { data: [entry], meta: { requestId: 'req_test_ok', nextCursor: 'page-2' } });
    });
    const { wrapper } = setup();

    const { result } = renderHook(() => useTaskFieldHistoryQuery(anna.id, alpha.id, taskId, fieldId), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(2);
      expect(result.current.hasNextPage).toBe(false);
    });

    expect(urls.map((url) => url.search)).toEqual(['?limit=50', '?limit=50&cursor=page-2']);
    expect(result.current.data?.pages).toEqual([
      { entries: [entry], nextCursor: 'page-2' },
      { entries: [], nextCursor: null },
    ]);
    expect(result.current.hasNextPage).toBe(false);
  });
});
