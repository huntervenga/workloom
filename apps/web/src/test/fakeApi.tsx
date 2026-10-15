import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActorDto, MembershipDto, ProjectDto, WorkspaceDto } from '@workloom/contracts';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';

/** Synthetic fixtures shaped by @workloom/contracts; they exist only in tests. */
export const anna: ActorDto = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Анна Тестова', kind: 'fixture' };
export const boris: ActorDto = { id: '22222222-2222-4222-8222-222222222222', displayName: 'Борис Пробный', kind: 'fixture' };

export const alpha: WorkspaceDto = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Альфа — тестовая команда',
  role: 'owner',
  timezone: 'Europe/Moscow',
};
export const beta: WorkspaceDto = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Бета — вторая команда',
  role: 'member',
  timezone: 'Asia/Nicosia',
};

export const alphaMembers: MembershipDto[] = [
  { id: 'c0000000-0000-4000-8000-000000000001', workspaceId: alpha.id, userId: anna.id, displayName: anna.displayName, role: 'owner' },
  { id: 'c0000000-0000-4000-8000-000000000002', workspaceId: alpha.id, userId: '33333333-3333-4333-8333-333333333333', displayName: 'Вера Образцова', role: 'admin' },
  { id: 'c0000000-0000-4000-8000-000000000003', workspaceId: alpha.id, userId: '44444444-4444-4444-8444-444444444444', displayName: 'Глеб Макетов', role: 'member' },
];

export const betaMembers: MembershipDto[] = [
  { id: 'd0000000-0000-4000-8000-000000000001', workspaceId: beta.id, userId: boris.id, displayName: boris.displayName, role: 'member' },
];

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function ok(data: unknown): Response {
  return json(200, { data, meta: { requestId: 'req_test_ok' } });
}

export function created(data: unknown): Response {
  return json(201, { data, meta: { requestId: 'req_test_created' } });
}

export function project(workspaceId: string, id: string, name: string, revision = 1): ProjectDto {
  return {
    id,
    workspaceId,
    name,
    revision,
    archivedAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
}

export function failure(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message, retryable: false }, meta: { requestId: 'req_test_err' } });
}

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
  credentials: RequestCredentials | undefined;
}

export type RouteTable = Record<string, (request: FakeRequest) => Response | Promise<Response>>;

const segment = '([^/]+)';

/**
 * Empty answers for custom field reads that tests written before them do not register: no
 * fields, revision-1 column settings and no values. A registered handler always wins.
 */
function defaultFieldRoute(request: FakeRequest): Response | null {
  if (request.method !== 'GET') return null;
  const workspaces = '^/api/v1/workspaces/';
  if (new RegExp(`${workspaces}${segment}/fields$`).test(request.path)) return ok([]);
  const columns = new RegExp(`${workspaces}${segment}/projects/${segment}/columns$`).exec(request.path);
  if (columns) {
    const [, workspaceId = '', projectId = ''] = columns;
    return ok({
      workspaceId: decodeURIComponent(workspaceId),
      projectId: decodeURIComponent(projectId),
      revision: 1,
      columns: [],
    });
  }
  if (new RegExp(`${workspaces}${segment}/(projects|tasks)/${segment}/field-values$`).test(request.path)) return ok([]);
  return null;
}

/** Replaces fetch with a table of "METHOD /path" handlers; unknown routes answer 404. */
export function installFakeApi(table: RouteTable): { calls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: FakeRequest = {
      method: init.method ?? 'GET',
      path: new URL(href, 'http://127.0.0.1:4311').pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
      credentials: init.credentials,
    };
    calls.push(request);
    const handler = table[`${request.method} ${request.path}`];
    if (handler) return handler(request);
    return defaultFieldRoute(request) ?? failure(404, 'NOT_FOUND', 'Route not found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function renderApp(path = '/') {
  const queryClient = createQueryClient({ retry: false });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <AppRoutes />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, user };
}

/** Routes for a single actor who can see the given workspaces. */
export function singleActorRoutes(
  actor: ActorDto,
  workspaces: WorkspaceDto[],
  members: Record<string, MembershipDto[]> = {},
): RouteTable {
  const table: RouteTable = {
    'GET /api/v1/me': () => ok({ actor, authMode: 'dev' }),
    'GET /api/v1/workspaces': () => ok(workspaces),
  };
  for (const workspace of workspaces) {
    table[`GET /api/v1/workspaces/${workspace.id}`] = () => ok(workspace);
    table[`GET /api/v1/workspaces/${workspace.id}/memberships`] = () => ok(members[workspace.id] ?? []);
    table[`GET /api/v1/workspaces/${workspace.id}/projects`] = () => ok([]);
  }
  return table;
}
