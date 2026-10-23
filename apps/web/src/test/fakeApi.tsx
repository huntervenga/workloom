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
  searchParams: URLSearchParams;
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
  const categoryBinding = new RegExp(`${workspaces}${segment}/projects/${segment}/work-category-binding$`).exec(request.path);
  if (categoryBinding) return ok({ workspaceId: categoryBinding[1], projectId: categoryBinding[2], revision: 1, versionId: null, fieldId: null, availability: 'unbound' });
  if (new RegExp(`${workspaces}${segment}/work-type-report-runs$`).test(request.path)) return ok([]);
  if (new RegExp(`${workspaces}${segment}/inbox$`).test(request.path) || new RegExp(`${workspaces}${segment}/inbox\\?`).test(request.path)) return ok([]);
  if (new RegExp(`${workspaces}${segment}/my-tasks$`).test(request.path)) return json(200, { data: [], meta: { requestId: 'fake-my-tasks', nextCursor: null } });
  const projectRules = new RegExp(`${workspaces}${segment}/projects/${segment}/rules$`).exec(request.path);
  if (projectRules) return ok({ workspaceId: decodeURIComponent(projectRules[1] ?? ''), projectId: decodeURIComponent(projectRules[2] ?? ''), revision: 0, config: { singleProject: false } });
  const taskDefaults = new RegExp(`${workspaces}${segment}/projects/${segment}/task-defaults$`).exec(request.path);
  if (taskDefaults) return ok({ workspaceId: decodeURIComponent(taskDefaults[1] ?? ''), projectId: decodeURIComponent(taskDefaults[2] ?? ''), revision: 0, config: { statusId: null, priority: null, estimateMinutes: null, fieldValues: [] } });

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
export function installFakeApi(table: RouteTable): { calls: FakeRequest[]; backgroundCalls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  const backgroundCalls: FakeRequest[] = [];
  let currentActorId: string | null = null;
  const currentMemberships = new Map<string, MembershipDto[]>();
  const knownProjects = new Set<string>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: FakeRequest = {
      method: init.method ?? 'GET',
      path: new URL(href, 'http://127.0.0.1:4311').pathname,
      searchParams: new URL(href, 'http://127.0.0.1:4311').searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
      credentials: init.credentials,
    };
    const handler = table[`${request.method} ${request.path}`];
    // Legacy static feature fixtures do not model collaboration. Unsupported background head
    // reads get a transient 503 and are recorded separately; explicitly registered head handlers
    // always win and remain in calls, including all live-refresh regression tests.
    if (!handler && request.method === 'GET' && /^\/api\/v1\/workspaces\/[^/]+\/change-head$/.test(request.path)) {
      backgroundCalls.push(request);
      return failure(503, 'UNAVAILABLE', 'Collaboration is not modeled by this fixture');
    }
    calls.push(request);
    if (handler) {
      const response = await handler(request);
      if (request.method === 'GET' && response.ok && (request.path === '/api/v1/me' || /\/memberships$/.test(request.path))) {
        // Malformed-success fixtures still reach the real API parser unchanged.
        const payload = await response.clone().json().catch(() => null) as { data?: { actor?: ActorDto } | MembershipDto[] } | null;
        if (!payload || typeof payload !== 'object') return response;
        if (request.path === '/api/v1/me') {
          const data = payload.data as { actor?: ActorDto } | undefined;
          currentActorId = typeof data?.actor?.id === 'string' ? data.actor.id.toLowerCase() : null;
        } else {
          const match = /^\/api\/v1\/workspaces\/([^/]+)\/memberships$/.exec(request.path);
          if (match?.[1] && Array.isArray(payload.data)) currentMemberships.set(decodeURIComponent(match[1]).toLowerCase(), payload.data);
        }
      }
      if (request.method === 'GET' && response.ok && currentActorId) {
        const match = /^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)$/.exec(request.path);
        if (match?.[1] && match[2]) {
          const payload = await response.clone().json().catch(() => null) as { data?: { id?: string; workspaceId?: string } } | null;
          const workspaceId = decodeURIComponent(match[1]).toLowerCase(), projectId = decodeURIComponent(match[2]).toLowerCase();
          if (typeof payload?.data?.id === 'string' && typeof payload.data.workspaceId === 'string' && payload.data.id.toLowerCase() === projectId && payload.data.workspaceId.toLowerCase() === workspaceId) knownProjects.add(`${currentActorId}:${workspaceId}:${projectId}`);
        }
      }
      return response;
    }
    // Unconfigured aggregate settings exist only for a project this actor actually read and a
    // modeled current membership. Explicit handlers above always win, including every denial.
    const aggregateSettings = request.method === 'GET' ? /^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/field-aggregate-settings$/.exec(request.path) : null;
    if (aggregateSettings?.[1] && aggregateSettings[2] && currentActorId) {
      const workspaceId = decodeURIComponent(aggregateSettings[1]).toLowerCase(), projectId = decodeURIComponent(aggregateSettings[2]).toLowerCase();
      if (knownProjects.has(`${currentActorId}:${workspaceId}:${projectId}`) && currentMemberships.get(workspaceId)?.some(member => member.userId.toLowerCase() === currentActorId)) return ok({ workspaceId, projectId, revision: 0, measures: [] });
    }
    const ownPreference = request.method === 'GET' ? /^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/table-preferences\/me$/.exec(request.path) : null;
    if (ownPreference?.[1] && ownPreference[2]) {
      const workspaceId = decodeURIComponent(ownPreference[1]).toLowerCase(), projectId = decodeURIComponent(ownPreference[2]).toLowerCase();
      const member = currentMemberships.get(workspaceId)?.find(row => row.userId.toLowerCase() === currentActorId && row.workspaceId.toLowerCase() === workspaceId);
      if (member) return ok({ workspaceId, projectId, membershipId: member.id.toLowerCase(), revision: 0, columns: null });
    }
    // Legacy fixtures with no history model receive a bounded empty feed. Registered handlers
    // always win above, including errors, pagination and all activity-specific regression tests.
    if (request.method === 'GET' && /^\/api\/v1\/workspaces\/[^/]+\/tasks\/[^/]+\/timeline$/.test(request.path)) return json(200, { data: [], meta: { requestId: 'fixture-timeline', nextCursor: null } });
    return defaultFieldRoute(request) ?? failure(404, 'NOT_FOUND', 'Route not found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, backgroundCalls };
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
