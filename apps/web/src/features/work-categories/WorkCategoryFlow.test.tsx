import { chooseTimeContext, timeContextLabel } from './test/timeContext';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alphaMembers, created, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { PERIOD_B, lostResponse, weekPath } from '../planning/test/fixtures';
import { FIELD, MEMBER_ID, OPTION_B, PERIOD_A, PROJECT_ID, TASK_ID, TYPE_RUN, binding, categorized, category, categoryReport, projection, rootPath, tablePath, tableRoutes, task } from './test/fixtures';

async function close(user: ReturnType<typeof renderApp>['user'], name: string) {
  const top = within(screen.getByRole('dialog', { name })).getAllByRole('button', { name: "Close" }).find((button) => button.hasAttribute('aria-label'));
  if (!top) throw new Error('Missing close button');
  await user.click(top);
}

async function selectWeek(user: ReturnType<typeof renderApp>['user']) {
  await chooseTimeContext(user, 'Week for hours', PERIOD_A);
  await screen.findByRole('button', { name: `Weekly actual hours: ${task.title}` });
}

describe('quick fact and category report boundaries', () => {
  it('keeps fact drafts across period/person lenses and resends the lost source under its original identity/key', async () => {
    const gate = lostResponse();
    let attempts = 0;
    const otherMember = alphaMembers[1]?.id;
    if (!otherMember) throw new Error('Missing colleague fixture');
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_B}/task-time-summary`]: (request) => ok({ ...projection(request.searchParams.get('membershipId') ?? MEMBER_ID), periodId: PERIOD_B }), [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => ++attempts === 1 ? gate.promise : ok(categorized(300)) });
    const { user } = renderApp(tablePath);
    await selectWeek(user);
    await user.click(screen.getByRole('button', { name: `Weekly actual hours: ${task.title}` }));
    let dialog = await screen.findByRole('dialog', { name: "Record weekly actual hours" });
    expect(within(dialog).getByRole("region", { name: "Time entry context" })).toHaveTextContent(task.title);
    expect(within(dialog).getByRole("region", { name: "Time entry context" })).toHaveTextContent(alphaMembers.find(member => member.id === MEMBER_ID)?.displayName ?? "");
    expect(within(dialog).queryByLabelText("Task")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Whose hours")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Actual hours this week"), '5');
    await close(user, "Record weekly actual hours");
    await chooseTimeContext(user, 'Week for hours', PERIOD_B);
    await chooseTimeContext(user, 'Whose hours to show', otherMember);
    await user.click(await screen.findByRole('button', { name: `Weekly actual hours: ${task.title}` }));
    dialog = await screen.findByRole('dialog', { name: "Record weekly actual hours" });
    await user.type(within(dialog).getByLabelText("Actual hours this week"), '2');
    await close(user, "Record weekly actual hours");
    await chooseTimeContext(user, 'Week for hours', PERIOD_A);
    await chooseTimeContext(user, 'Whose hours to show', MEMBER_ID);
    await user.click(await screen.findByRole('button', { name: `Weekly actual hours: ${task.title}` }));
    dialog = await screen.findByRole('dialog', { name: "Record weekly actual hours" });
    expect(within(dialog).getByLabelText("Actual hours this week")).toHaveValue('5');
    await user.click(within(dialog).getByRole('button', { name: "Save actual hours" }));
    await waitFor(() => expect(attempts).toBe(1));
    await close(user, "Record weekly actual hours");
    await chooseTimeContext(user, 'Week for hours', PERIOD_B);
    await chooseTimeContext(user, 'Whose hours to show', otherMember);
    await act(async () => gate.lose());
    await user.click(await screen.findByRole('button', { name: "Open original hours save" }));
    dialog = await screen.findByRole('dialog', { name: "Record weekly actual hours" });
    expect(within(dialog).getByLabelText("Actual hours this week")).toHaveValue('5:00');
    expect(screen.getByLabelText("Week for hours")).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A));
    expect(screen.getByLabelText("Whose hours to show")).toHaveTextContent(timeContextLabel('Whose hours to show', MEMBER_ID));
    await user.click(within(dialog).getByRole('button', { name: "Retry original save" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const writes = calls.filter((call) => call.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual({ expectedRevision: null, minutes: 300, state: 'active', reason: null });
    expect(writes[1]?.path).toBe(writes[0]?.path);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    await chooseTimeContext(user, 'Week for hours', PERIOD_B);
    await chooseTimeContext(user, 'Whose hours to show', otherMember);
    await user.click(await screen.findByRole('button', { name: `Weekly actual hours: ${task.title}` }));
    dialog = await screen.findByRole('dialog', { name: "Record weekly actual hours" });
    expect(within(dialog).getByLabelText("Actual hours this week")).toHaveValue('2');
  });

  it('requires an explicit reason for recategorization and sends only immutable source/revision/category inputs', async () => {
    let current = categorized();
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_A}/task-time-summary`]: () => ok(projection(MEMBER_ID, current)), [`POST ${rootPath}/worklogs/${current.id}/recategorize`]: () => { current = { ...categorized(60, 2), category: category(OPTION_B, 'Поддержка команды') }; return ok(current); } });
    const { user } = renderApp(tablePath);
    await selectWeek(user);
    await user.click(screen.getByRole('button', { name: `Weekly actual hours: ${task.title}` }));
    const fact = await screen.findByRole('dialog', { name: "Edit weekly actual hours" });
    expect(within(fact).getByText('Исследование')).toBeInTheDocument();
    await user.click(within(fact).getByRole('button', { name: "Change recorded work type" }));
    const dialog = await screen.findByRole('dialog', { name: "Change recorded work type" });
    await user.selectOptions(within(dialog).getByLabelText("New work type"), OPTION_B);
    await user.click(within(dialog).getByRole('button', { name: "Save new work type" }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Give a reason");
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText("Reason for changing work type"), 'Уточнили характер работы');
    await user.click(within(dialog).getByRole('button', { name: "Save new work type" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const write = calls.find((call) => call.method === 'POST');
    expect(write?.body).toEqual({ expectedWorkLogRevision: 1, expectedBindingRevision: binding().revision, optionId: OPTION_B, reason: 'Уточнили характер работы' });
    expect(write?.body).not.toHaveProperty('minutes');
    expect(write?.body).not.toHaveProperty('fieldId');
    expect(screen.getByRole('button', { name: `Weekly actual hours: ${task.title}` })).toHaveTextContent("1h");
    expect(await screen.findByText('Поддержка команды')).toBeInTheDocument();
  });

  it('renders server category percentages including uncategorized before freeze, independent of paginated source rows', async () => {
    let rowReads = 0;
    const { calls } = installFakeApi({ ...tableRoutes(), [`POST ${rootPath}/work-type-report-runs`]: () => created(categoryReport()), [`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}`]: () => ok(categoryReport()), [`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}/rows`]: () => { rowReads += 1; return new Response(JSON.stringify({ data: [], meta: { requestId: 'req_types', nextCursor: rowReads === 1 ? 'next-sources' : null } }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=work-types`);
    await user.click(await screen.findByRole('button', { name: "Calculate hours breakdown" }));
    expect(await screen.findByRole('img', { name: 'Исследование: 1h, 50%' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Uncategorized: 30m, 25%' })).toBeInTheDocument();
    expect(screen.getByText('Active entries: 3. These are recorded hours; they do not prove that all work for the week has been logged. Unrecorded work remains unknown.')).toBeInTheDocument();
    const write = calls.find((call) => call.method === 'POST');
    expect(write?.body).toEqual({ periodId: PERIOD_A, membershipIds: [] });
    expect(write?.body).not.toHaveProperty('baselineId');
    await user.click(await screen.findByRole('button', { name: "Load more source entries" }));
    await waitFor(() => expect(rowReads).toBe(2));
    expect(screen.getByRole('img', { name: 'Uncategorized: 30m, 25%' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('weekly_work_type_v1');
    expect(document.body).not.toHaveTextContent(FIELD);
  });
});
