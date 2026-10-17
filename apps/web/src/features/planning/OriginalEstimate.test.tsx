import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OriginalPackageEstimateDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { formatDate } from '../../i18n';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, deferred, failure, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { formatEstimate } from '../task-table';
import { OriginalEstimate } from './OriginalEstimate';
import { planningKeys } from './queries';
import { BASELINE_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, rootPath, STAMP } from './test/fixtures';

const FOREIGN_ID = 'f1000000-0000-4000-8000-000000000099';
const url = `GET ${rootPath}/planning-packages/${PACKAGE_ID}/original-estimate`;
const target = { workspaceId: alpha.id, projectId: PROJECT_ID, workPackageId: PACKAGE_ID };
const origin = { planBaselineId: BASELINE_ID, periodId: PERIOD_A, periodLocalStart: '2026-10-19', scope: 'self', mode: 'cutoff', frozenAt: STAMP, packageRevision: 1 } as const;
const pending: OriginalPackageEstimateDto = { state: 'not_captured_yet', ...target };
const capturedZero: OriginalPackageEstimateDto = { state: 'captured', ...target, estimateMinutes: 0, packageBaselineId: 'f9000000-0000-4000-8000-000000000001', acceptedAt: STAMP, provenance: 'first_known_plan_freeze', origin };
const unknown: OriginalPackageEstimateDto = { state: 'original_unknown', ...target, estimateMinutes: null, packageBaselineId: null, origin };

function renderOriginal(table: RouteTable, client: QueryClient = createQueryClient({ retry: false })) {
  const api = installFakeApi(table);
  const user = userEvent.setup();
  const view = render(<QueryClientProvider client={client}><OriginalEstimate actorId={anna.id} workspaceId={alpha.id} packageId={PACKAGE_ID} /></QueryClientProvider>);
  return { ...api, ...view, client, user };
}
const originText = () => screen.getByText((text) => text.startsWith('First freeze:'));

describe('read-only original package estimate', () => {
  it('shows a captured zero as a known original with its immutable first-freeze origin', async () => {
    const { calls } = renderOriginal({ [url]: () => ok(capturedZero) });
    expect(screen.getByRole('status')).toHaveTextContent('Checking the original estimate…');
    expect(await screen.findByText(formatEstimate(0))).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Original estimate' })).toBeInTheDocument();
    expect(screen.getByText('Locked at first freeze')).toBeInTheDocument();
    expect(screen.getByText("Saved by the first plan freeze that included this work. Later estimate edits don't change it.")).toBeInTheDocument();
    expect(originText()).toHaveTextContent(`Week of ${formatDate('2026-10-19', { dateStyle: 'medium' })}`);
    expect(originText()).toHaveTextContent('Personal plan freeze');
    expect(originText()).toHaveTextContent('Saved at the cutoff');
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('Not captured yet')).not.toBeInTheDocument();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([url]);
  });

  it('keeps an unknown first observation unknown and never renders minutes', async () => {
    renderOriginal({ [url]: () => ok(unknown) });
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Not set at first freeze')).toBeInTheDocument();
    expect(screen.getByText('No estimate was set when this work was first frozen. A later estimate is not treated as the original.')).toBeInTheDocument();
    expect(originText()).toBeInTheDocument();
    expect(screen.queryByText(formatEstimate(0))).not.toBeInTheDocument();
    expect(screen.queryByText('Locked at first freeze')).not.toBeInTheDocument();
  });

  it('separates not-captured-yet from unknown and rereads it on every mount', async () => {
    const client = createQueryClient({ retry: false });
    const first = renderOriginal({ [url]: () => ok(pending) }, client);
    expect(await screen.findByText('Not captured yet')).toBeInTheDocument();
    expect(screen.getByText('Not in a baseline yet')).toBeInTheDocument();
    expect(screen.queryByText((text) => text.startsWith('First freeze:'))).not.toBeInTheDocument();
    first.unmount();
    const second = renderOriginal({ [url]: () => ok(capturedZero) }, client);
    expect(await screen.findByText('Locked at first freeze')).toBeInTheDocument();
    expect(second.calls).toHaveLength(1);
    second.unmount();
    // A captured original is immutable; the normal stale window applies after capture.
    const third = renderOriginal({ [url]: () => ok(capturedZero) }, client);
    expect(screen.getByText('Locked at first freeze')).toBeInTheDocument();
    expect(third.calls).toHaveLength(0);
  });

  it('keeps the initial read as a loading status until the server answers', async () => {
    const answer = deferred<Response>();
    renderOriginal({ [url]: () => answer.promise });
    expect(screen.getByRole('status')).toHaveTextContent('Checking the original estimate…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    answer.resolve(ok(unknown));
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each([
    ['another package', { ...capturedZero, workPackageId: FOREIGN_ID }],
    ['another workspace', { ...capturedZero, workspaceId: FOREIGN_ID }],
  ])('treats a successful response for %s as a neutral failure with an explicit retry', async (_case, wrong) => {
    let attempts = 0;
    const second = deferred<Response>();
    const { calls, user } = renderOriginal({ [url]: () => (++attempts === 1 ? ok(wrong) : second.promise) });
    expect(await screen.findByRole('alert')).toHaveTextContent('The original estimate could not be loaded.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Locked at first freeze')).not.toBeInTheDocument();
    expect(screen.queryByText(formatEstimate(0))).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FOREIGN_ID);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Checking the original estimate…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    second.resolve(ok(capturedZero));
    expect(await screen.findByText('Locked at first freeze')).toBeInTheDocument();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([url, url]);
  });

  it.each([
    ['package', { workspaceId: alpha.id, packageId: 'not-a-package' }],
    ['workspace', { workspaceId: 'not-a-workspace', packageId: PACKAGE_ID }],
  ])('shows a malformed %s target as unavailable without any read', async (_case, ids) => {
    const { calls } = installFakeApi({ [url]: () => ok(capturedZero) });
    render(<QueryClientProvider client={createQueryClient({ retry: false })}><OriginalEstimate actorId={anna.id} {...ids} /></QueryClientProvider>);
    expect(screen.getByText('The original estimate is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('shows a denied or revoked read as unavailable without a retry or stale value', async () => {
    renderOriginal({ [url]: () => failure(404, 'NOT_FOUND', 'Not found') });
    expect(await screen.findByRole('alert')).toHaveTextContent('The original estimate is not available.');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Locked at first freeze')).not.toBeInTheDocument();
  });

  it.each([403, 404])('hides a cached original and freeze provenance after an authoritative %s refetch', async status => {
    let allowed = true;
    const captured = { ...capturedZero, estimateMinutes: 450 };
    const { calls, client } = renderOriginal({ [url]: () => allowed ? ok(captured) : failure(status, status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', 'private freeze diagnostic') });
    const key = planningKeys.originalEstimate(anna.id, alpha.id, PACKAGE_ID);
    expect(await screen.findByText(formatEstimate(450))).toBeInTheDocument();
    expect(originText()).toBeInTheDocument();
    allowed = false;
    await act(async () => { await client.invalidateQueries({ queryKey: key, exact: true }); });
    // TanStack retains the last successful value on refetch errors; authorization must win over it.
    expect(client.getQueryData(key)).toEqual(captured);
    expect(await screen.findByRole('alert')).toHaveTextContent('The original estimate is not available.');
    expect(screen.queryByText(formatEstimate(450))).not.toBeInTheDocument();
    expect(screen.queryByText('Locked at first freeze')).not.toBeInTheDocument();
    expect(screen.queryByText(text => text.startsWith('First freeze:'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private freeze diagnostic');
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET']);
  });

  it('keeps the cached immutable original after a transient 503 refetch', async () => {
    let available = true;
    const { calls, client } = renderOriginal({ [url]: () => available ? ok(capturedZero) : failure(503, 'TEMPORARILY_UNAVAILABLE', 'private server diagnostic') });
    const key = planningKeys.originalEstimate(anna.id, alpha.id, PACKAGE_ID);
    expect(await screen.findByText('Locked at first freeze')).toBeInTheDocument();
    available = false;
    await act(async () => { await client.invalidateQueries({ queryKey: key, exact: true }); });
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'));
    expect(screen.getByText(formatEstimate(0))).toBeInTheDocument();
    expect(originText()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private server diagnostic');
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET']);
  });

  it('retries only a failed read, shows the retry as loading, and stays read-only', async () => {
    let attempts = 0;
    const second = deferred<Response>(), third = deferred<Response>();
    const { calls, user } = renderOriginal({ [url]: () => (++attempts === 1 ? failure(500, 'INTERNAL', 'Failure') : attempts === 2 ? second.promise : third.promise) });
    expect(await screen.findByRole('alert')).toHaveTextContent('The original estimate could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Checking the original estimate…');
    second.resolve(failure(503, 'TEMPORARILY_UNAVAILABLE', 'Unavailable'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The original estimate could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    third.resolve(ok(unknown));
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
  });
});
