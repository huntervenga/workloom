import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, ok, project, renderApp } from '../../test/fakeApi';
import { PROJECT_ID, rootPath, tablePath, tableRoutes, task } from '../work-categories/test/fixtures';

beforeAll(async () => { await import('../../routes/ProjectPage'); });

const headPath = `${rootPath}/change-head`;
const projectsPath = `${rootPath}/projects`;
const current = project(alpha.id, PROJECT_ID, 'Недельный пилот');
const projectList = queryKeys.projectList(anna.id, alpha.id);
function head(changeSeq: string) {
  return { workspaceId: alpha.id, actorUserId: anna.id, membershipId: alphaMembers[0]?.id,
    membershipRevision: 1, role: 'owner', changeSeq, permissionEpoch: '0' };
}

async function settle() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/**
 * Real shell, Sidebar, MobileNav and live-refresh hook. The initial project-list GET stays held
 * while the first safe head starts catch-up (its task-list refresh is held too), then the real
 * navigation dialog acquires protection. Every answer is a synthetic fixture.
 */
async function protectDuringCatchUp() {
  const headStarted = deferred<null>(); const initialHead = deferred<Response>();
  const projectsStarted = deferred<null>(); const initialProjects = deferred<Response>(); const retryProjects = deferred<Response>();
  const catchUpStarted = deferred<null>(); const heldCatchUp = deferred<Response>();
  let headReads = 0; let projectReads = 0; let armed = false;
  const api = installFakeApi({ ...tableRoutes(),
    // Registered explicitly: the legacy unsupported-head fallback is never used here.
    [`GET ${headPath}`]: () => { if (++headReads > 1) return ok(head('1')); headStarted.resolve(null); return initialHead.promise; },
    [`GET ${projectsPath}`]: () => { if (++projectReads > 1) return retryProjects.promise; projectsStarted.resolve(null); return initialProjects.promise; },
    // After the first head is released, task-list reads belong to its catch-up and stay held.
    [`GET ${rootPath}/tasks`]: () => { if (!armed) return ok([task]); catchUpStarted.resolve(null); return heldCatchUp.promise; },
  });
  const ui = renderApp(tablePath);
  cleanups.push(() => { ui.unmount(); ui.queryClient.clear(); });

  await act(async () => { await Promise.all([headStarted.promise, projectsStarted.promise]); });
  const table = await screen.findByRole('table');
  const aside = within(screen.getByRole('complementary', { name: 'Sidebar' }));
  expect(within(aside.getByRole('navigation', { name: 'Active projects' })).getByRole('status')).toHaveTextContent('Loading projects');
  expect(ui.queryClient.getQueryState(projectList)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });

  armed = true;
  await act(async () => { initialHead.resolve(ok(head('1'))); await catchUpStarted.promise; });
  // Catch-up overlaps the never-successful initial list read without starting another list read.
  expect(projectReads).toBe(1);
  expect(ui.queryClient.getQueryState(projectList)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });

  await ui.user.click(screen.getByRole('button', { name: 'Open menu' }));
  const dialog = await screen.findByRole('dialog', { name: 'Navigation' }); await settle();
  // Cache barrier: the open dialog acquired protection and aborted the held catch-up refresh.
  expect(ui.queryClient.isFetching({ queryKey: queryKeys.tasks(anna.id, alpha.id) })).toBe(0);
  expect(ui.queryClient.getQueryState(projectList)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });
  expect(projectReads).toBe(1); expect(headReads).toBe(1);
  const nav = within(within(dialog).getByRole('navigation', { name: 'Active projects' }));
  return { api, ui, table, nav, initialProjects, retryProjects, reads: () => ({ head: headReads, projects: projectReads }) };
}

function expectQuietShell(race: Awaited<ReturnType<typeof protectDuringCatchUp>>) {
  // The modal drawer hides the shell from the accessibility tree; the page itself stays mounted.
  expect(screen.getByRole('table', { hidden: true })).toBe(race.table);
  expect(screen.queryByText('Workspace unavailable')).not.toBeInTheDocument();
  expect(race.api.backgroundCalls).toHaveLength(0);
  expect(race.api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  expect(race.reads().head).toBe(1);
}

describe('initial ordinary read across live catch-up and navigation protection', () => {
  it('publishes a labeled initial 503 as an explicit Sidebar retry, never a stuck loading state', async () => {
    const race = await protectDuringCatchUp();
    await act(async () => race.initialProjects.resolve(failure(503, 'UNAVAILABLE', 'Synthetic initial project-list outage')));
    await settle();
    expect(await race.nav.findByText('Projects could not be loaded.')).toBeInTheDocument();
    expect(race.nav.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading projects')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic initial project-list outage')).not.toBeInTheDocument();
    expect(race.ui.queryClient.getQueryState(projectList)).toMatchObject({ status: 'error', fetchStatus: 'idle', dataUpdateCount: 0 });
    const retry = race.nav.getByRole('button', { name: 'Try again' }); expect(retry).toBeEnabled();
    expect(race.reads().projects).toBe(1); expectQuietShell(race);

    await race.ui.user.click(retry); await settle();
    expect(race.reads().projects).toBe(2);
    // Refetching a query that never succeeded resets it to pending, so Sidebar shows its loading
    // status (not a disabled retry) until the explicit retry settles; no second action exists.
    expect(race.ui.queryClient.getQueryState(projectList)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', dataUpdateCount: 0 });
    expect(race.nav.getByRole('status')).toHaveTextContent('Loading projects');
    expect(race.nav.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(race.nav.queryByText('Projects could not be loaded.')).not.toBeInTheDocument();
    await settle(); expect(race.reads().projects).toBe(2); expectQuietShell(race);
    await act(async () => race.retryProjects.resolve(ok([current])));
    expect(await race.nav.findByRole('link', { name: current.name })).toHaveAttribute('href', tablePath);
    expect(race.nav.queryByText('Projects could not be loaded.')).not.toBeInTheDocument();
    expect(race.reads().projects).toBe(2); expectQuietShell(race);
  });

  it('publishes an initial success that arrives while navigation is protected', async () => {
    const race = await protectDuringCatchUp();
    await act(async () => race.initialProjects.resolve(ok([current])));
    expect(await race.nav.findByRole('link', { name: current.name })).toHaveAttribute('href', tablePath);
    expect(race.nav.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading projects')).not.toBeInTheDocument();
    expect(race.ui.queryClient.getQueryState(projectList)).toMatchObject({ status: 'success', fetchStatus: 'idle', dataUpdateCount: 1 });
    expect(race.reads().projects).toBe(1); expectQuietShell(race);
  });
});
