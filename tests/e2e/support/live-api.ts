// Reads the expected actor, workspaces and members from the running API (through the
// Vite /api proxy at baseURL), so browser assertions follow the real seeded database
// instead of hard-coded fixture names.
import type { APIRequestContext } from '@playwright/test';
import {
  meResponseSchema,
  membershipListResponseSchema,
  workspaceListResponseSchema,
  type MeDto,
  type MembershipDto,
  type WorkspaceDto,
} from '@workloom/contracts';

export interface LiveData {
  readonly me: MeDto;
  readonly workspaces: readonly WorkspaceDto[];
  readonly firstWorkspace: WorkspaceDto;
  readonly members: readonly MembershipDto[];
}

const SETUP_HINT =
  'Existing local PostgreSQL must already be running and migrated. ' +
  'Use node scripts/local-runtime.mjs doctor and docs/26-local-runtime.md; do not reseed or initialize an existing database to run tests. ' +
  'The default config reuses web 4311; a frozen compiled-app override may use 4310.';


async function getJson(request: APIRequestContext, path: string): Promise<unknown> {
  let response;
  try {
    response = await request.get(path, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`GET ${path} failed: ${error instanceof Error ? error.message : String(error)}. ${SETUP_HINT}`);
  }
  if (!response.ok()) {
    throw new Error(`GET ${path} returned ${response.status()}: ${await response.text()}. ${SETUP_HINT}`);
  }
  return response.json();
}

export async function loadLiveData(request: APIRequestContext): Promise<LiveData> {
  const me = meResponseSchema.parse(await getJson(request, '/api/v1/me')).data;
  const workspaces = workspaceListResponseSchema.parse(await getJson(request, '/api/v1/workspaces')).data;
  const firstWorkspace = workspaces[0];
  if (!firstWorkspace) {
    throw new Error(`The dev actor "${me.actor.displayName}" has no workspace. ${SETUP_HINT}`);
  }
  const members = membershipListResponseSchema.parse(
    await getJson(request, `/api/v1/workspaces/${firstWorkspace.id}/memberships`),
  ).data;
  return { me, workspaces, firstWorkspace, members };
}
