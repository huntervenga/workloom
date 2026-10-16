import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { created, failure, installFakeApi, json, ok, renderApp } from '../../test/fakeApi';
import { planningKeys } from './queries';
import { alpha, alphaMembers, anna } from '../../test/fakeApi';
import { BASELINE_ID, MEMBER_ID, PROJECT_ID, PERIOD_A, PERIOD_B, PERSONAL_BASELINE_ID, RUN_ID, TASK_ID, baseline, commitment, log, lostResponse, period, report, rootPath, routes, snapshot, weekPath } from './test/fixtures';

// Radix has both a top close icon and a visible close action. Target its labelled top button.
async function close(user: ReturnType<typeof renderApp>['user'], name: string) {
  const dialog = screen.getByRole('dialog', { name });
  const buttons = within(dialog).getAllByRole('button', { name: "Close" });
  const topClose = buttons.find((button) => button.hasAttribute('aria-label'));
  if (!topClose) throw new Error('Expected accessible close button');
  await user.click(topClose);
}

async function openPlan(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: "Add to plan" }, { timeout: 5000 }));
  return screen.findByRole('dialog', { name: "Add to weekly plan" });
}

describe('weekly planning lifecycle', () => {
  it('labels the deadline in the period zone instead of silently using the browser zone', async () => {
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}`]: () => ok({ ...period(), timezone: 'Asia/Nicosia', cutoffAt: '2026-10-19T22:30:00.000Z' }) });
    renderApp(`${weekPath}?period=${PERIOD_A}`);
    const deadline = await screen.findByText(/^Baseline deadline:/);
    expect(deadline).toHaveTextContent(/10\/20\/26.*1:30 AM/);
  });

  it('keeps independent period drafts and retries a lost create under its original period and exact key', async () => {
    const gate = lostResponse();
    let attempts = 0;
    const { calls } = installFakeApi({ ...routes(), [`POST ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ++attempts === 1 ? gate.promise : created(commitment(180)) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    let dialog = await openPlan(user);
    await user.selectOptions(within(dialog).getByLabelText("Whole task"), 'f1000000-0000-4000-8000-000000000001');
    await user.type(within(dialog).getByLabelText("Planned hours"), '3');
    await close(user, "Add to weekly plan");
    await user.selectOptions(screen.getByLabelText("Period", { exact: true }), PERIOD_B);
    dialog = await openPlan(user);
    await user.type(within(dialog).getByLabelText("Planned hours"), '2');
    await close(user, "Add to weekly plan");
    await user.selectOptions(screen.getByLabelText("Period", { exact: true }), PERIOD_A);
    dialog = await openPlan(user);
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('3');
    await user.click(within(dialog).getByRole('button', { name: "Save personal plan" }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user, "Add to weekly plan");
    await user.selectOptions(screen.getByLabelText("Period", { exact: true }), PERIOD_B);
    await act(async () => gate.lose());
    await user.click(await screen.findByRole('button', { name: "Open original save" }));
    dialog = await screen.findByRole('dialog', { name: "Add to weekly plan" });
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('3:00');
    expect(within(dialog).getByLabelText("Planned hours")).toBeDisabled();
    expect(screen.getByLabelText("Period", { exact: true })).toHaveValue(PERIOD_A);
    await user.click(within(dialog).getByRole('button', { name: "Retry original save" }));
    await waitFor(() => expect(attempts).toBe(2));
    const writes = calls.filter((call) => call.method === 'POST');
    expect(writes[1]?.path).toBe(writes[0]?.path);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(writes[0]?.body).toMatchObject({ plannedMinutes: 180, expectedAbsent: true, membershipId: MEMBER_ID });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Period", { exact: true }), PERIOD_B);
    dialog = await openPlan(user);
    expect(within(dialog).getByLabelText("Planned hours")).toHaveValue('2');
  });

  it('submits explicit zero without a first-entry reason and requires a reason for a real correction', async () => {
    let saved = false;
    let current = log();
    const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/recorded-work`]: () => ok(saved ? [current] : []), [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => { current = saved ? log(60, 2) : log(); saved = true; return ok(current); } });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: "Record actual hours" }));
    let dialog = await screen.findByRole('dialog', { name: "Record weekly actual hours" });
    await user.selectOptions(within(dialog).getByLabelText("Task"), TASK_ID);
    await user.type(within(dialog).getByLabelText("Actual hours this week"), '0');
    await user.click(within(dialog).getByRole('button', { name: "Save actual hours" }));
    await user.click(await screen.findByRole('button', { name: "Edit actual hours" }));
    dialog = await screen.findByRole('dialog', { name: "Edit weekly actual hours" });
    await user.clear(within(dialog).getByLabelText("Actual hours this week"));
    await user.type(within(dialog).getByLabelText("Actual hours this week"), '1');
    await user.click(within(dialog).getByRole('button', { name: "Save actual hours" }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Give a reason");
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    await user.type(within(dialog).getByLabelText("Reason for correction"), 'Уточнил часы');
    await user.click(within(dialog).getByRole('button', { name: "Save actual hours" }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2));
    const writes = calls.filter((call) => call.method === 'PUT');
    expect(writes[0]?.body).toEqual({ expectedRevision: null, minutes: 0, state: 'active', reason: null });
    expect(writes[1]?.body).toEqual({ expectedRevision: 1, minutes: 60, state: 'active', reason: 'Уточнил часы' });
  });

  it('requires a new server preview and explicit confirmation after PREVIEW_STALE', async () => {
    let previews = 0;
    let freezes = 0;
    const { calls } = installFakeApi({ ...routes(), [`POST ${rootPath}/periods/${PERIOD_A}/freeze-preview`]: () => ok({ periodId: PERIOD_A, scope: 'project', membershipId: null, previewHash: (++previews === 1 ? 'a' : 'b').repeat(64), snapshot: snapshot(), existingBaselineId: null }), [`POST ${rootPath}/periods/${PERIOD_A}/freeze`]: () => ++freezes === 1 ? failure(409, 'PREVIEW_STALE', 'Private internal details') : ok(baseline()) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: "Save project baseline" }));
    let dialog = await screen.findByRole('dialog', { name: "Save project baseline" });
    await user.click(await within(dialog).findByRole('button', { name: "Confirm baseline" }));
    await within(dialog).findByText("The plan changed after your preview. Load a fresh preview and confirm the freeze again.");
    expect(within(dialog).getByRole('button', { name: "Confirm baseline" })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: "Refresh preview" }));
    await waitFor(() => expect(previews).toBe(2));
    dialog = screen.getByRole('dialog', { name: "Save project baseline" });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: "Confirm baseline" })).toBeEnabled());
    expect(freezes).toBe(1);
    await user.click(within(dialog).getByRole('button', { name: "Confirm baseline" }));
    await waitFor(() => expect(freezes).toBe(2));
    const previewCalls = calls.filter((call) => call.path.endsWith('/freeze-preview'));
    expect(previewCalls.every((call) => !call.headers.has('Idempotency-Key'))).toBe(true);
    const writes = calls.filter((call) => call.path.endsWith('/freeze'));
    expect(writes[0]?.body).toEqual({ scope: 'project', previewHash: 'a'.repeat(64) });
    expect(writes[1]?.body).toEqual({ scope: 'project', previewHash: 'b'.repeat(64) });
    expect(writes[0]?.headers.get('Idempotency-Key')).not.toBe(writes[1]?.headers.get('Idempotency-Key'));
  });

  it('restricts personal snapshot people and renders authoritative chart totals before detail pages load', async () => {
    let rowReads = 0;
    const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline(), baseline(true)]), [`POST ${rootPath}/report-runs`]: () => created(report()), [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(report()), [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => json(200, { data: [], meta: { requestId: 'req_rows', nextCursor: ++rowReads === 1 ? 'second-page' : null } }) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report`);
    const select = await screen.findByLabelText("Saved baseline");
    await user.selectOptions(select, BASELINE_ID);
    await user.click(screen.getByRole('checkbox', { name: 'Вера Образцова' }));
    await user.selectOptions(select, PERSONAL_BASELINE_ID);
    expect(screen.queryByRole('checkbox', { name: 'Вера Образцова' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Calculate new report" }));
    expect(await screen.findByRole('img', { name: 'Анна Тестова, plan: 6h' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Анна Тестова, actual: 5h' })).toBeInTheDocument();
    expect(screen.queryByText('weekly_plan_fact_v1')).not.toBeInTheDocument();
    const write = calls.find((call) => call.method === 'POST');
    expect(write?.body).toMatchObject({ baselineId: PERSONAL_BASELINE_ID, membershipIds: [] });
    await user.click(await screen.findByRole('button', { name: "Load more report rows" }));
    await waitFor(() => expect(rowReads).toBe(2));
    expect(screen.getByRole('img', { name: 'Анна Тестова, plan: 6h' })).toBeInTheDocument();
  });
  it('hides loaded weekly names and any open editor after an authoritative read denial', async () => {
    let denied = false;
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/commitments`]: () => denied ? failure(403, 'FORBIDDEN', 'Sensitive server text') : ok([commitment()]) });
    const { user, queryClient } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: "Edit plan" }));
    expect(await screen.findByRole('dialog', { name: "Personal weekly plan" })).toBeInTheDocument();
    denied = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: planningKeys.commitments(anna.id, alpha.id, PERIOD_A), exact: true }); });
    expect(await screen.findByRole('heading', { name: "Unable to load week" })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Исследовать недельный сценарий')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Sensitive server text');
  });

  it('keeps report selection drafts through another period loading and excludes empty original cohorts from the chart', async () => {
    const run = report();
    run.byPerson.push({ membershipId: 'c0000000-0000-4000-8000-000000000002', memberName: 'Без исходного плана', summary: { ...run.summary, baselineCompleteness: { knownItemCount: 0, totalItemCount: 0, ratio: null, complete: false } } });
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]), [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(run), [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => ok([]) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    await user.click(screen.getByRole('checkbox', { name: /Compare only known personal plans/ }));
    expect(await screen.findByRole('img', { name: 'Анна Тестова, plan: 6h' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /No baseline/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Period", { exact: true }), PERIOD_B);
    await screen.findByText("Save a personal or project baseline before calculating a comparison.");
    await user.selectOptions(screen.getByLabelText("Period", { exact: true }), PERIOD_A);
    expect(await screen.findByRole('checkbox', { name: /Compare only known personal plans/ })).toBeChecked();
  });

});


describe('explicit weekly person and period context', () => {
  it('keeps an unselected table week empty and carries the person back after an explicit week selection', async () => {
    const colleague = alphaMembers[1]; if (!colleague) throw new Error('Missing colleague');
    const { calls } = installFakeApi(routes());
    const { user } = renderApp(`${weekPath}?period=&worker=${colleague.id}`);
    expect(await screen.findByRole('heading', { name: 'Choose a week' })).toBeInTheDocument();
    expect(screen.getByLabelText('Period', { exact: true })).toHaveValue('');
    expect(screen.getByLabelText('Time entry for')).toHaveValue(colleague.id);
    expect(calls.some(call => /\/periods\/[^/]+$/.test(call.path))).toBe(false);
    await user.selectOptions(screen.getByLabelText('Period', { exact: true }), PERIOD_B);
    await screen.findByRole('button', { name: 'Add to plan' });
    expect(screen.getByRole('link', { name: 'Back to task table' })).toHaveAttribute('href', `/w/${alpha.id}/projects/${PROJECT_ID}?week=${PERIOD_B}&worker=${colleague.id}`);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps independent same-week person drafts and resumes a lost save under its original person and key', async () => {
    const colleague = alphaMembers[1]; if (!colleague) throw new Error('Missing colleague');
    const gate = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi({ ...routes(), [`POST ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ++attempts === 1 ? gate.promise : created(commitment(180)) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&worker=${colleague.id}`);
    let dialog = await openPlan(user);
    expect(within(dialog).getByRole('region', { name: 'Time entry context' })).toHaveTextContent(colleague.displayName);
    expect(within(dialog).queryByLabelText('Whose plan')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Planned hours'), '2');
    await close(user, 'Add to weekly plan');
    await user.selectOptions(screen.getByLabelText('Time entry for'), MEMBER_ID);
    dialog = await openPlan(user);
    await user.selectOptions(within(dialog).getByLabelText('Whole task'), 'f1000000-0000-4000-8000-000000000001');
    await user.type(within(dialog).getByLabelText('Planned hours'), '3');
    await user.click(within(dialog).getByRole('button', { name: 'Save personal plan' }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user, 'Add to weekly plan');
    await user.selectOptions(screen.getByLabelText('Time entry for'), colleague.id);
    dialog = await openPlan(user);
    expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('2');
    await act(async () => gate.lose());
    expect(within(dialog).getByRole('button', { name: 'Save personal plan' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Retry original save' })).not.toBeInTheDocument();
    await close(user, 'Add to weekly plan');
    await user.click(screen.getByRole('button', { name: 'Open original save' }));
    dialog = await screen.findByRole('dialog', { name: 'Add to weekly plan' });
    expect(screen.getByLabelText('Time entry for')).toHaveValue(MEMBER_ID);
    expect(within(dialog).getByRole('region', { name: 'Time entry context' })).toHaveTextContent(anna.displayName);
    await user.click(within(dialog).getByRole('button', { name: 'Retry original save' }));
    await waitFor(() => expect(attempts).toBe(2));
    const writes = calls.filter(call => call.method === 'POST');
    expect(writes[0]?.body).toMatchObject({ membershipId: MEMBER_ID, plannedMinutes: 180 });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Time entry for'), colleague.id);
    dialog = await openPlan(user);
    expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('2');
  });

  it('never replaces an unavailable carried person with the actor and does not change report people', async () => {
    const missing = 'c0000000-0000-4000-8000-000000009999';
    const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&worker=${missing}`);
    expect(await screen.findByRole('button', { name: 'Add to plan' })).toBeDisabled();
    expect(screen.getByLabelText('Time entry for')).toHaveValue(missing);
    expect(screen.getByRole('button', { name: 'Record actual hours' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Report' }));
    expect(screen.getByRole('checkbox', { name: anna.displayName })).not.toBeChecked();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
