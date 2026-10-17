import type { OriginalPackageEstimateDto } from '@workloom/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { OriginalEstimate } from './OriginalEstimate';
import { planningKeys, usePlanningCommands } from './queries';
import { BASELINE_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, STAMP, baseline, commitment, rootPath, routes, weekPath } from './test/fixtures';

beforeAll(async () => { await import('../../routes/WeeklyPage'); });
const originalPath = `${rootPath}/planning-packages/${PACKAGE_ID}/original-estimate`;
const original: OriginalPackageEstimateDto = { state: 'original_unknown', workspaceId: alpha.id, projectId: PROJECT_ID, workPackageId: PACKAGE_ID, estimateMinutes: null, packageBaselineId: null, origin: { planBaselineId: BASELINE_ID, periodId: PERIOD_A, periodLocalStart: '2026-10-19', scope: 'project', mode: 'manual', frozenAt: STAMP, packageRevision: 1 } };

describe('original estimate in weekly planning', () => {
  it('shows the current shared budget alongside an unknown immutable original on a saved locked plan', async () => {
    const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ok([{ ...commitment(), baselineIds: [BASELINE_ID] }]), [`GET ${originalPath}`]: () => ok(original) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: 'View plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Personal weekly plan' });
    expect(within(dialog).getByRole('region', { name: 'Current shared estimate' })).toHaveTextContent('20h');
    const saved = within(dialog).getByRole('region', { name: 'Original estimate' });
    expect(await within(saved).findByText('Unknown')).toBeVisible();
    expect(saved).not.toHaveTextContent('20h');
    expect(within(dialog).getByLabelText('Planned hours')).toBeDisabled();
    expect(calls.filter(call => call.path === originalPath)).toHaveLength(1);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('never requests an original for a new empty plan draft', async () => {
    const { calls } = installFakeApi(routes());
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: 'Add to plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Add to weekly plan' });
    expect(within(dialog).queryByRole('region', { name: 'Original estimate' })).not.toBeInTheDocument();
    expect(calls.some(call => call.path.includes('/original-estimate'))).toBe(false);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('invalidates the workspace original-estimate prefix after a confirmed freeze while retaining other actors caches', async () => {
    let frozen = false;
    const { calls } = installFakeApi({ [`GET ${originalPath}`]: () => ok(frozen ? original : { state: 'not_captured_yet', workspaceId: alpha.id, projectId: PROJECT_ID, workPackageId: PACKAGE_ID }), [`POST ${rootPath}/periods/${PERIOD_A}/freeze`]: () => { frozen = true; return ok(baseline()); } });
    function Example() {
      const commands = usePlanningCommands(anna.id, alpha.id, PROJECT_ID);
      return <><OriginalEstimate actorId={anna.id} workspaceId={alpha.id} packageId={PACKAGE_ID} /><button onClick={() => commands.freeze.mutate({ periodId: PERIOD_A, input: { scope: 'project', previewHash: 'a'.repeat(64) } })}>Confirm fixture freeze</button></>;
    }
    const ui = renderFieldUi(<Example />);
    await screen.findByText('Not captured yet');
    const siblingKey = planningKeys.originalEstimate(anna.id, alpha.id, 'f1000000-0000-4000-8000-000000000002');
    const foreignActorKey = planningKeys.originalEstimate('b0000000-0000-4000-8000-000000000099', alpha.id, PACKAGE_ID);
    ui.client.setQueryData(siblingKey, original);
    ui.client.setQueryData(foreignActorKey, original);
    await ui.user.click(screen.getByRole('button', { name: 'Confirm fixture freeze' }));
    expect(await screen.findByText('Unknown')).toBeVisible();
    await waitFor(() => expect(ui.client.getQueryState(siblingKey)?.isInvalidated).toBe(true));
    expect(ui.client.getQueryState(foreignActorKey)?.isInvalidated).toBe(false);
    expect(calls.filter(call => call.path === originalPath)).toHaveLength(2);
    const writes = calls.filter(call => call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ scope: 'project', previewHash: 'a'.repeat(64) });
  });
});
