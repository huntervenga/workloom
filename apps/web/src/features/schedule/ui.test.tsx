import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { TaskDto, TaskScheduleBatchInput } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { ok, installFakeApi, renderApp } from '../../test/fakeApi';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import { baseline, period } from '../planning/test/fixtures';
import { scheduledTask, scheduleContext, schedulePreview, schedulePath, PROJECT_ID, BASELINE_ID, PERIOD_A, rootPath } from './test/fixtures';

const routes = (tasks: () => TaskDto[]) => ({ ...tableRoutes(),
  [`GET ${rootPath}/tasks`]: () => ok(tasks()),
  [`GET ${rootPath}/periods`]: () => ok([period()]),
  [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]),
  [`GET ${schedulePath}/schedule-context`]: (request: { searchParams: URLSearchParams }) => {
    const ids = new Set(request.searchParams.get('taskIds')?.split(','));
    return ok(scheduleContext(tasks().filter(task => ids.has(task.id)), request.searchParams.get('baselineId') === BASELINE_ID));
  },
});

describe('actual project date view and date editor', () => {
  it('bounds a full 9999-year task range, keeps date states explicit and never turns a meeting into a task bar', async () => {
    const extreme = scheduledTask(1, '0001-01-01', '9999-12-31');
    const dated = scheduledTask(2, '2026-03-29', '2026-03-29');
    const missing = scheduledTask(3);
    const meeting = { ...scheduledTask(4, '2026-03-29', '2026-03-29'), meetingId: 'af000000-0000-4000-8000-000000000001' };
    const all = [extreme, dated, missing, meeting];
    const { calls } = installFakeApi({ ...routes(() => all),
      [`GET ${schedulePath}/schedule-context`]: request => ok(scheduleContext(all, request.searchParams.has('baselineId'), '1', task => task.id === extreme.id ? { state: 'captured', startDate: { state: 'set', value: '0001-01-01' }, dueDate: { state: 'set', value: '9999-12-31' } } : { state: 'captured', startDate: { state: 'not_captured' }, dueDate: { state: 'not_set' } })),
    });
    const { user } = renderApp(`${tablePath}?view=gantt`);
    // The first full-app lookup includes the cold lazy project route, which can exceed 1s under parallel test load.
    const gantt = await screen.findByRole('region', { name: "Project timeline" }, { timeout: 5000 });
    await within(gantt).findByRole('group', { name: `Calendar dates: ${extreme.title}` });
    // First open fits the loaded 0001..9999 span: bounded to the first 366 days and explained.
    expect(within(gantt).getByLabelText("Window start")).toHaveValue('0001-01-01');
    expect(within(gantt).getByRole('status')).toHaveTextContent(/more than|showing the first 366 from the earliest/);
    await user.selectOptions(within(gantt).getByLabelText("Days in window"), '28');
    fireEvent.change(within(gantt).getByLabelText("Window start"), { target: { value: '2026-03-28' } });
    const axis = within(gantt).getByRole('list', { name: "Calendar window days" });
    expect(within(axis).getAllByRole('listitem')).toHaveLength(28);
    const full = within(gantt).getByRole('img', { name: "Current: start 0001-01-01, due 9999-12-31" });
    expect(full).toHaveStyle({ left: '0%', width: '100%' });
    expect(full.textContent?.startsWith('‹')).toBe(true);
    expect(full.textContent?.endsWith('›')).toBe(true);
    await user.selectOptions(within(gantt).getByLabelText("Days in window"), '366');
    expect(within(axis).getAllByRole('listitem')).toHaveLength(366);
    // 366 days use the narrowest bounded column: 12px × 366, never a 0001..9999 range width.
    expect(within(gantt).getByRole('list', { name: "Calendar window days" }).style.width).toBe('4392px');
    const meetRow = within(gantt).getByRole('group', { name: `Calendar dates: ${meeting.title}` });
    expect(within(meetRow).getByRole('button', { name: "Meeting — open calendar" })).toBeInTheDocument();
    expect(within(meetRow).queryByRole('img')).not.toBeInTheDocument();
    expect(within(meetRow).queryByRole('button', { name: "Edit dates" })).not.toBeInTheDocument();
    await user.click(within(gantt).getByRole('button', { name: "Compare with frozen plan" }));
    await user.selectOptions(within(gantt).getByLabelText("Plan period"), PERIOD_A);
    await waitFor(() => expect(within(gantt).getByRole('combobox', { name: "Frozen plan to compare" })).toBeEnabled());
    await user.selectOptions(within(gantt).getByLabelText("Frozen plan to compare"), BASELINE_ID);
    await waitFor(() => expect(within(gantt).getAllByText(/Start date was not captured in this plan/).length).toBeGreaterThan(0));
    expect(within(gantt).getByRole('img', { name: "Frozen: start 0001-01-01, due 9999-12-31" })).toHaveStyle({ left: '0%', width: '100%' });
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    fireEvent.change(within(gantt).getByLabelText("Window start"), { target: { value: '9999-12-31' } });
    expect(within(within(gantt).getByRole('list', { name: "Calendar window days" })).getAllByRole('listitem')).toHaveLength(1);
    expect(within(gantt).getByRole('button', { name: "Next window" })).toBeDisabled();
  });

  it('edits dates through reviewed atomic apply and leaves whole-task effort and package revisions alone', async () => {
    let current = scheduledTask(1, '2026-03-28', '2026-03-29');
    const estimate = current.estimateMinutes, packageRevision = current.workPackageRevision;
    const { calls } = installFakeApi({ ...routes(() => [current]),
      [`POST ${schedulePath}/schedule-preview`]: request => ok(schedulePreview(request.body as TaskScheduleBatchInput, [current])),
      [`POST ${schedulePath}/schedule-apply`]: request => {
        const row = (request.body as TaskScheduleBatchInput).rows[0];
        if (!row) throw new Error('Expected submitted date row');
        current = { ...current, startDate: row.startDate, dueDate: row.dueDate, revision: current.revision + 1 };
        return ok({ projectId: PROJECT_ID, tasks: [current], asOfChangeSeq: '2' });
      },
    });
    const { user } = renderApp(`${tablePath}?view=gantt`);
    const row = await screen.findByRole('group', { name: `Calendar dates: ${current.title}` }, { timeout: 5000 });
    await user.click(within(row).getByRole('button', { name: "Edit dates" }));
    const dialog = await screen.findByRole('dialog', { name: "Edit task dates" });
    fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: '2026-04-02' } });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: '2026-04-05' } });
    expect(within(dialog).getByRole('button', { name: "Apply dates" })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: "Preview changes" }));
    await within(dialog).findByRole('region', { name: "Task date change preview" });
    expect(within(dialog).getByText('After: 2026-04-02 — 2026-04-05')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: "Apply dates" }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Edit task dates" })).not.toBeInTheDocument());
    expect(current).toMatchObject({ startDate: '2026-04-02', dueDate: '2026-04-05', revision: 2, estimateMinutes: estimate, workPackageRevision: packageRevision });
    const preview = calls.find(call => call.path.endsWith('/schedule-preview'));
    const apply = calls.find(call => call.path.endsWith('/schedule-apply'));
    expect(preview?.headers.get('Idempotency-Key')).toBeNull();
    expect(apply?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
    expect(apply?.body).toEqual({ rows: [{ taskId: current.id, expectedRevision: 1, startDate: '2026-04-02', dueDate: '2026-04-05' }], previewHash: 'a'.repeat(64) });
  });
});
