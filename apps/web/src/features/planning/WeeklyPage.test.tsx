import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { created, failure, installFakeApi, json, ok, renderApp } from '../../test/fakeApi';
import { planningKeys } from './queries';
import { alpha, anna } from '../../test/fakeApi';
import { BASELINE_ID, MEMBER_ID, PERIOD_A, PERIOD_B, PERSONAL_BASELINE_ID, RUN_ID, TASK_ID, baseline, commitment, log, lostResponse, period, report, rootPath, routes, snapshot, weekPath } from './test/fixtures';

// Radix has both a top close icon and a visible close action. Target its labelled top button.
async function close(user: ReturnType<typeof renderApp>['user'], name: string) {
  const dialog = screen.getByRole('dialog', { name });
  const buttons = within(dialog).getAllByRole('button', { name: 'Закрыть' });
  const topClose = buttons.find((button) => button.hasAttribute('aria-label'));
  if (!topClose) throw new Error('Expected accessible close button');
  await user.click(topClose);
}

async function openPlan(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Добавить в план' }, { timeout: 5000 }));
  return screen.findByRole('dialog', { name: 'Добавить в недельный план' });
}

describe('weekly planning lifecycle', () => {
  it('labels the deadline in the period zone instead of silently using the browser zone', async () => {
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}`]: () => ok({ ...period(), timezone: 'Asia/Nicosia', cutoffAt: '2026-10-19T22:30:00.000Z' }) });
    renderApp(`${weekPath}?period=${PERIOD_A}`);
    const deadline = await screen.findByText(/^Срок фиксации \(Asia\/Nicosia\):/);
    expect(deadline).toHaveTextContent(/20.*10.*01:30/);
  });

  it('keeps independent period drafts and retries a lost create under its original period and exact key', async () => {
    const gate = lostResponse();
    let attempts = 0;
    const { calls } = installFakeApi({ ...routes(), [`POST ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ++attempts === 1 ? gate.promise : created(commitment(180)) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    let dialog = await openPlan(user);
    await user.selectOptions(within(dialog).getByLabelText('Задача целиком'), 'f1000000-0000-4000-8000-000000000001');
    await user.type(within(dialog).getByLabelText('Личный план, часы'), '3');
    await close(user, 'Добавить в недельный план');
    await user.selectOptions(screen.getByLabelText('Период', { exact: true }), PERIOD_B);
    dialog = await openPlan(user);
    await user.type(within(dialog).getByLabelText('Личный план, часы'), '2');
    await close(user, 'Добавить в недельный план');
    await user.selectOptions(screen.getByLabelText('Период', { exact: true }), PERIOD_A);
    dialog = await openPlan(user);
    expect(within(dialog).getByLabelText('Личный план, часы')).toHaveValue('3');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить личный план' }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user, 'Добавить в недельный план');
    await user.selectOptions(screen.getByLabelText('Период', { exact: true }), PERIOD_B);
    await act(async () => gate.lose());
    await user.click(await screen.findByRole('button', { name: 'Открыть исходную отправку' }));
    dialog = await screen.findByRole('dialog', { name: 'Добавить в недельный план' });
    expect(within(dialog).getByLabelText('Личный план, часы')).toHaveValue('3:00');
    expect(within(dialog).getByLabelText('Личный план, часы')).toBeDisabled();
    expect(screen.getByLabelText('Период', { exact: true })).toHaveValue(PERIOD_A);
    await user.click(within(dialog).getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() => expect(attempts).toBe(2));
    const writes = calls.filter((call) => call.method === 'POST');
    expect(writes[1]?.path).toBe(writes[0]?.path);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(writes[0]?.body).toMatchObject({ plannedMinutes: 180, expectedAbsent: true, membershipId: MEMBER_ID });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Период', { exact: true }), PERIOD_B);
    dialog = await openPlan(user);
    expect(within(dialog).getByLabelText('Личный план, часы')).toHaveValue('2');
  });

  it('submits explicit zero without a first-entry reason and requires a reason for a real correction', async () => {
    let saved = false;
    let current = log();
    const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/recorded-work`]: () => ok(saved ? [current] : []), [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => { current = saved ? log(60, 2) : log(); saved = true; return ok(current); } });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: 'Внести факт' }));
    let dialog = await screen.findByRole('dialog', { name: 'Внести факт за неделю' });
    await user.selectOptions(within(dialog).getByLabelText('Задача для факта'), TASK_ID);
    await user.type(within(dialog).getByLabelText('Факт за неделю, часы'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить факт за неделю' }));
    await user.click(await screen.findByRole('button', { name: 'Изменить факт' }));
    dialog = await screen.findByRole('dialog', { name: 'Изменить факт за неделю' });
    await user.clear(within(dialog).getByLabelText('Факт за неделю, часы'));
    await user.type(within(dialog).getByLabelText('Факт за неделю, часы'), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить факт за неделю' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Для исправления');
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    await user.type(within(dialog).getByLabelText('Причина исправления'), 'Уточнил часы');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить факт за неделю' }));
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
    await user.click(await screen.findByRole('button', { name: 'Зафиксировать план проекта' }));
    let dialog = await screen.findByRole('dialog', { name: 'Зафиксировать план проекта' });
    await user.click(await within(dialog).findByRole('button', { name: 'Подтвердить фиксацию' }));
    await within(dialog).findByText('План изменился после предпросмотра. Загрузите свежий предпросмотр и подтвердите фиксацию ещё раз.');
    expect(within(dialog).getByRole('button', { name: 'Подтвердить фиксацию' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Обновить предпросмотр' }));
    await waitFor(() => expect(previews).toBe(2));
    dialog = screen.getByRole('dialog', { name: 'Зафиксировать план проекта' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Подтвердить фиксацию' })).toBeEnabled());
    expect(freezes).toBe(1);
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить фиксацию' }));
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
    const select = await screen.findByLabelText('Исходный снимок плана');
    await user.selectOptions(select, BASELINE_ID);
    await user.click(screen.getByRole('checkbox', { name: 'Вера Образцова' }));
    await user.selectOptions(select, PERSONAL_BASELINE_ID);
    expect(screen.queryByRole('checkbox', { name: 'Вера Образцова' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Рассчитать новый отчёт' }));
    expect(await screen.findByRole('img', { name: 'Анна Тестова, план: 6 ч' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Анна Тестова, факт: 5 ч' })).toBeInTheDocument();
    expect(screen.queryByText('weekly_plan_fact_v1')).not.toBeInTheDocument();
    const write = calls.find((call) => call.method === 'POST');
    expect(write?.body).toMatchObject({ baselineId: PERSONAL_BASELINE_ID, membershipIds: [] });
    await user.click(await screen.findByRole('button', { name: 'Загрузить ещё строки расчёта' }));
    await waitFor(() => expect(rowReads).toBe(2));
    expect(screen.getByRole('img', { name: 'Анна Тестова, план: 6 ч' })).toBeInTheDocument();
  });
  it('hides loaded weekly names and any open editor after an authoritative read denial', async () => {
    let denied = false;
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/commitments`]: () => denied ? failure(403, 'FORBIDDEN', 'Sensitive server text') : ok([commitment()]) });
    const { user, queryClient } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: 'Изменить план' }));
    expect(await screen.findByRole('dialog', { name: 'Личный план на неделю' })).toBeInTheDocument();
    denied = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: planningKeys.commitments(anna.id, alpha.id, PERIOD_A), exact: true }); });
    expect(await screen.findByRole('heading', { name: 'Не удалось загрузить неделю' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Исследовать недельный сценарий')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Sensitive server text');
  });

  it('keeps report selection drafts through another period loading and excludes empty original cohorts from the chart', async () => {
    const run = report();
    run.byPerson.push({ membershipId: 'c0000000-0000-4000-8000-000000000002', memberName: 'Без исходного плана', summary: { ...run.summary, baselineCompleteness: { knownItemCount: 0, totalItemCount: 0, ratio: null, complete: false } } });
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]), [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(run), [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => ok([]) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    await user.click(await screen.findByRole('checkbox', { name: /Сравнить только известные личные планы/ }));
    expect(await screen.findByRole('img', { name: 'Анна Тестова, план: 6 ч' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Без исходного плана/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Период', { exact: true }), PERIOD_B);
    await screen.findByText('Сначала зафиксируйте личный план или план проекта, чтобы рассчитать сравнение.');
    await user.selectOptions(screen.getByLabelText('Период', { exact: true }), PERIOD_A);
    expect(await screen.findByRole('checkbox', { name: /Сравнить только известные личные планы/ })).toBeChecked();
  });

});
