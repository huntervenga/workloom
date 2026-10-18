import type { OriginalPackageEstimateDto, TaskDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, deferred, failure, installFakeApi, ok, renderApp, type RouteTable } from '../../test/fakeApi';
import { BASELINE_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, STAMP, rootPath, task } from '../planning/test/fixtures';
import { formatEstimate, formatEstimateInput } from '../task-table';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';

beforeAll(async () => { await import('../../routes/ProjectPage'); });
const OWN_PACKAGE = 'f1000000-0000-4000-8000-000000000041';
// The fixture task's current shared estimate is 1200 minutes.
const detailChild: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000041', parentTaskId: task.id, title: 'Detail child' };
const additionalChild: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000042', parentTaskId: task.id, title: 'Additional child', workPackageId: OWN_PACKAGE, estimateMinutes: 90 };
const target = (workPackageId = PACKAGE_ID) => ({ workspaceId: alpha.id, projectId: PROJECT_ID, workPackageId });
const origin = { planBaselineId: BASELINE_ID, periodId: PERIOD_A, periodLocalStart: '2026-10-19', scope: 'project', mode: 'manual', frozenAt: STAMP, packageRevision: 1 } as const;
const capturedZero: OriginalPackageEstimateDto = { state: 'captured', ...target(), estimateMinutes: 0, packageBaselineId: 'f9000000-0000-4000-8000-000000000001', acceptedAt: STAMP, provenance: 'first_known_plan_freeze', origin };
const unknown: OriginalPackageEstimateDto = { state: 'original_unknown', ...target(), estimateMinutes: null, packageBaselineId: null, origin };
const pending = (workPackageId = PACKAGE_ID): OriginalPackageEstimateDto => ({ state: 'not_captured_yet', ...target(workPackageId) });
const originalPath = (packageId: string) => `${rootPath}/planning-packages/${packageId}/original-estimate`;

function routes(original: Record<string, () => Response>, extra: RouteTable = {}): RouteTable {
  const table: RouteTable = { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => ok([task, detailChild, additionalChild]) };
  for (const row of [task, detailChild, additionalChild]) table[`GET ${rootPath}/tasks/${row.id}`] = () => ok(row);
  for (const [packageId, answer] of Object.entries(original)) table[`GET ${originalPath(packageId)}`] = answer;
  return { ...table, ...extra };
}
type Calls = ReturnType<typeof installFakeApi>['calls'];
const originalReads = (calls: Calls) => calls.filter(call => call.path.endsWith('/original-estimate'));
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
async function drawer(title: string) {
  const dialog = within(await screen.findByRole('dialog', { name: title }));
  return { dialog, current: dialog.getByLabelText('Team estimate, hours'), original: dialog.getByRole('region', { name: 'Original estimate' }) };
}

describe('drawer current and original estimates', () => {
  it('shows a captured zero original beside the current estimate field, with only a read on open', async () => {
    const { calls } = installFakeApi(routes({ [PACKAGE_ID]: () => ok(capturedZero) }));
    renderApp(`${tablePath}?task=${task.id}`);
    const { current, original } = await drawer(task.title);
    expect(current).toHaveValue(formatEstimateInput(1200));
    expect(await within(original).findByText(formatEstimate(0))).toBeInTheDocument();
    expect(within(original).getByText('Locked at first freeze')).toBeInTheDocument();
    expect(within(original).queryByText(formatEstimate(1200))).not.toBeInTheDocument();
    expect(originalReads(calls).map(call => `${call.method} ${call.path}`)).toEqual([`GET ${originalPath(PACKAGE_ID)}`]);
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps an unknown original unknown even though a current estimate exists', async () => {
    installFakeApi(routes({ [PACKAGE_ID]: () => ok(unknown) }));
    renderApp(`${tablePath}?task=${task.id}`);
    const { current, original } = await drawer(task.title);
    expect(await within(original).findByText('Unknown')).toBeInTheDocument();
    expect(within(original).queryByText(formatEstimate(1200))).not.toBeInTheDocument();
    expect(current).toHaveValue(formatEstimateInput(1200));
  });

  it('claims no lock while the original is not captured yet', async () => {
    installFakeApi(routes({ [PACKAGE_ID]: () => ok(pending()) }));
    renderApp(`${tablePath}?task=${task.id}`);
    const { dialog, current } = await drawer(task.title);
    expect(await dialog.findByText('Not captured yet')).toBeInTheDocument();
    expect(dialog.queryByText(/Locked/)).not.toBeInTheDocument();
    expect(current).toHaveValue(formatEstimateInput(1200));
    expect(current).toHaveAccessibleDescription(/Shared budget for the whole team/);
  });

  it('reads the parent’s package for a detail child and the child’s own package for additional work', async () => {
    const { calls } = installFakeApi(routes({ [PACKAGE_ID]: () => ok(capturedZero), [OWN_PACKAGE]: () => ok(pending(OWN_PACKAGE)) }));
    const { user } = renderApp(`${tablePath}?task=${task.id}`);
    await within((await drawer(task.title)).original).findByText(formatEstimate(0));
    await user.click(screen.getByRole('button', { name: /^Open subtask “Detail child”/ }));
    const detail = await drawer(detailChild.title);
    expect(await within(detail.original).findByText(formatEstimate(0))).toBeInTheDocument();
    expect(detail.current).toHaveValue(formatEstimateInput(1200));
    await user.click(detail.dialog.getByRole('button', { name: 'Open parent' }));
    await user.click(await screen.findByRole('button', { name: /^Open subtask “Additional child”/ }));
    const additional = await drawer(additionalChild.title);
    expect(await within(additional.original).findByText('Not captured yet')).toBeInTheDocument();
    expect(additional.current).toHaveValue(formatEstimateInput(90));
    const paths = new Set(originalReads(calls).map(call => call.path));
    expect(paths).toEqual(new Set([originalPath(PACKAGE_ID), originalPath(OWN_PACKAGE)]));
    expect(writes(calls)).toHaveLength(0);
  });

  it('shows a denied original as unavailable without hiding the current value', async () => {
    installFakeApi(routes({ [PACKAGE_ID]: () => failure(403, 'FORBIDDEN', 'private original detail') }));
    renderApp(`${tablePath}?task=${task.id}`);
    const { current, original } = await drawer(task.title);
    expect(await within(original).findByText('The original estimate is not available.')).toBeInTheDocument();
    expect(current).toHaveValue(formatEstimateInput(1200));
    expect(screen.queryByText('private original detail')).not.toBeInTheDocument();
  });

  it('marks the current value as saved while an unsaved estimate is in the form', async () => {
    installFakeApi(routes({ [PACKAGE_ID]: () => ok(capturedZero) }));
    const { user } = renderApp(`${tablePath}?task=${task.id}`);
    const { dialog } = await drawer(task.title);
    const more = dialog.queryByText('More details', { selector: 'summary' });
    if (more && !more.parentElement?.hasAttribute('open')) await user.click(more);
    const input = dialog.getByLabelText('Team estimate, hours');
    await user.clear(input); await user.type(input, '3');
    const saved = dialog.getByRole('region', { name: 'Current shared estimate' });
    expect(within(saved).getByText('Saved value. Your unsaved estimate is in the form above.')).toBeInTheDocument();
    expect(within(saved).getByText(formatEstimate(1200))).toBeInTheDocument();
    expect(input).toHaveValue('3');
    expect(dialog.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('reads no package estimate until the saved task detail has loaded', async () => {
    const detail = deferred<Response>();
    const { calls } = installFakeApi(routes({ [PACKAGE_ID]: () => ok(capturedZero) }, {
      [`GET ${rootPath}/tasks/${task.id}`]: () => detail.promise,
    }));
    renderApp(`${tablePath}?task=${task.id}`);
    const loading = within(await screen.findByRole('dialog', { name: 'Task' }));
    await waitFor(() => expect(calls.some(call => call.path === `${rootPath}/tasks/${task.id}`)).toBe(true));
    expect(loading.queryByRole('region', { name: 'Original estimate' })).not.toBeInTheDocument();
    expect(originalReads(calls)).toHaveLength(0);
    await act(async () => { detail.resolve(ok(task)); });
    expect(await within((await drawer(task.title)).original).findByText(formatEstimate(0))).toBeInTheDocument();
    expect(originalReads(calls)).toHaveLength(1);
    expect(writes(calls)).toHaveLength(0);
  });

  it('reads no original for the new-task composer', async () => {
    const { calls } = installFakeApi(routes({}));
    const { user } = renderApp(`${tablePath}?view=board`);
    await screen.findByRole('region', { name: 'Task status lanes' });
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    const composer = within(await screen.findByRole('dialog', { name: 'New task' }));
    expect(composer.queryByRole('region', { name: 'Original estimate' })).not.toBeInTheDocument();
    expect(composer.queryByRole('region', { name: 'Current shared estimate' })).not.toBeInTheDocument();
    await waitFor(() => expect(composer.getByLabelText('Task name')).toBeInTheDocument());
    expect(originalReads(calls)).toHaveLength(0); expect(writes(calls)).toHaveLength(0);
  });
});
