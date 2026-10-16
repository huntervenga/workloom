import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  createRecurrenceSeriesInputSchema,
  meetingSchema,
  recurrenceReadinessSchema,
  taskSchema,
  type MeetingDto,
  type RecurrenceReadinessDto,
  type TaskDto,
} from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { isUuid } from '../../lib/format';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, ok, renderApp, type FakeRequest } from '../../test/fakeApi';
import { MEMBER_ID, PERIOD_A, PERIOD_B, PROJECT_ID, STAMP, period, rootPath, task, weekPath } from '../planning/test/fixtures';
import { tableRoutes } from '../work-categories/test/fixtures';
import { recurrenceKeys } from './queries';
import {
  ATTENDEE_IDS,
  HASH_A,
  MEETING_ID,
  MEETING_PACKAGE_ID,
  MEETING_TASK_ID,
  SERIES_ID,
  createInput,
  createPreview,
  createPreviewInput,
  createPreviewPath,
  instance,
  instancesPath,
  materialization,
  plannedCalendar,
  materializePath,
  readiness,
  readinessPath,
  series,
  seriesListPath,
} from './test/fixtures';

/*
 * The recurrence section of the real WeeklyPage: real router, session, QueryClient and hooks.
 * Only fetch is replaced; every answer is a contract-parsed synthetic DTO for existing test periods.
 */

const seriesPath = `${rootPath}/recurrence-series/${SERIES_ID}`;
const schedule = createPreviewInput([PERIOD_A]).schedule;
const template = createPreviewInput([PERIOD_A]).template;
const attendees = alphaMembers.filter((member) => ATTENDEE_IDS.includes(member.id));
/** Mon/Wed of week A: the first header is prepared below, the second was cancelled before preparation. */
const [preparedKey, cancelledKey] = createPreview(HASH_A, PERIOD_A).candidates.filter((item) => item.periodId === PERIOD_A).map((item) => item.occurrenceKey);
const periodChoice = (id: string) => new RegExp(`^${period(id).name}`);

const preparedHeader = instance(preparedKey ?? '', { ordinal: 1, materialized: true });
const meetingTask: TaskDto = taskSchema.parse({
  ...task,
  id: MEETING_TASK_ID,
  meetingId: MEETING_ID,
  workPackageId: MEETING_PACKAGE_ID,
  estimateMinutes: schedule.plannedDurationMinutes,
  participants: attendees.map((member) => ({ membershipId: member.id, role: 'assignee', active: true, revision: 1 })),
  title: template.title,
});
const meeting: MeetingDto = meetingSchema.parse({
  id: MEETING_ID,
  workspaceId: alpha.id,
  projectId: PROJECT_ID,
  taskId: MEETING_TASK_ID,
  workPackageId: MEETING_PACKAGE_ID,
  revision: 1,
  participantsRevision: 1,
  plannedPeriodId: PERIOD_A,
  plannedStartAt: preparedHeader.resolution.resolvedStartAt,
  timezone: schedule.timezone,
  plannedDurationMinutes: schedule.plannedDurationMinutes,
  organizerMembershipId: MEMBER_ID,
  state: 'scheduled',
  actualStartAt: null,
  actualDurationMinutes: null,
  joinUrl: null,
  recordingUrl: null,
  summaryUrl: null,
  summaryText: null,
  scheduleFrozen: false,
  hasPostedAttendance: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  recurrence: { seriesId: SERIES_ID, instanceId: preparedHeader.id, occurrenceKey: preparedHeader.occurrenceKey, nominalSequence: 1 },
});

function headers(prepared: boolean) {
  return [instance(preparedKey ?? '', { ordinal: 1, materialized: prepared }), instance(cancelledKey ?? '', { ordinal: 2, cancelled: true })];
}

/** Nothing bound yet: a complete period without series rows. */
function emptyReadiness(periodId: string): RecurrenceReadinessDto {
  return recurrenceReadinessSchema.parse({ ...readiness(periodId, 0), bindings: [] });
}

function writesOf(calls: FakeRequest[]): FakeRequest[] {
  return calls.filter((call) => call.method !== 'GET' && call.path !== createPreviewPath);
}

// Radix has both a top close icon and a visible close action. Target its labelled top button.
async function close(user: ReturnType<typeof renderApp>['user'], name: string) {
  const buttons = within(screen.getByRole('dialog', { name })).getAllByRole('button', { name: 'Закрыть' });
  const topClose = buttons.find((button) => button.hasAttribute('aria-label'));
  if (!topClose) throw new Error('Expected accessible close button');
  await user.click(topClose);
}

describe('weekly page recurrence panel', () => {
  it('creates an explicit previewed series through a lost-create retry, prepares only the chosen period and opens the prepared occurrence', async () => {
    expect(preparedKey).toBeDefined();
    expect(cancelledKey).toBeDefined();
    const expectedPreview = createPreviewInput([PERIOD_A]);
    const confirmed = series(expectedPreview);
    const lostCreate = deferred<undefined>();
    const state = { created: false, prepared: false, createAttempts: 0 };
    const { calls } = installFakeApi({
      ...tableRoutes(),
      [`GET ${seriesListPath}`]: () => ok(state.created ? [confirmed] : []),
      [`GET ${seriesPath}`]: () => ok(confirmed),
      [`POST ${createPreviewPath}`]: () => ok(createPreview(HASH_A, PERIOD_A)),
      [`POST ${seriesListPath}`]: async () => {
        state.createAttempts += 1;
        if (state.createAttempts === 1) {
          await lostCreate.promise;
          throw new TypeError('Failed to fetch');
        }
        state.created = true;
        return created(confirmed);
      },
      [`GET ${readinessPath(PERIOD_A)}`]: () =>
        ok(!state.created ? emptyReadiness(PERIOD_A) : readiness(PERIOD_A, state.prepared ? 0 : 1)),
      [`GET ${instancesPath()}`]: () => ok(headers(state.prepared)),
      [`POST ${materializePath(PERIOD_A)}`]: () => {
        state.prepared = true;
        return ok(materialization(PERIOD_A, { createdCount: 1, remainingCount: 0, nextCursor: null }));
      },
      [`GET ${rootPath}/projects/${PROJECT_ID}/meetings`]: () => ok(state.prepared ? [{ task: meetingTask, meeting }] : []),
      [`GET ${rootPath}/tasks/${MEETING_TASK_ID}`]: () => ok(meetingTask),
      [`GET ${rootPath}/tasks/${MEETING_TASK_ID}/meeting`]: () => ok(meeting),
      [`GET ${rootPath}/tasks/${MEETING_TASK_ID}/attendance`]: () => ok([]),
    });
    const writes = () => writesOf(calls);
    const previews = () => calls.filter((call) => call.path === createPreviewPath);
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);

    const panel = await screen.findByRole('region', { name: 'Повторяющиеся встречи' }, { timeout: 5000 });
    const newSeries = within(panel).getByRole('button', { name: 'Новая серия встреч' });
    await waitFor(() => expect(newSeries).toBeEnabled());
    await user.click(newSeries);
    let dialog = await screen.findByRole('dialog', { name: 'Новая серия встреч' });

    // Nothing is chosen for the user: no start date, attendee or period, and nothing to create yet.
    expect(within(dialog).getByLabelText('Дата начала серии')).toHaveValue('');
    for (const member of alphaMembers) expect(within(dialog).getByRole('checkbox', { name: member.displayName })).not.toBeChecked();
    for (const id of [PERIOD_A, PERIOD_B]) expect(within(dialog).getByRole('checkbox', { name: periodChoice(id) })).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Создать серию' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Проверить расписание' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(previews()).toEqual([]);

    // Explicit Mon/Wed rule, attendees and one period.
    for (const day of ['Вторник', 'Четверг', 'Пятница']) await user.click(within(dialog).getByRole('checkbox', { name: day }));
    fireEvent.change(within(dialog).getByLabelText('Дата начала серии'), { target: { value: schedule.startDate } });
    const count = within(dialog).getByLabelText('Число встреч в серии');
    await user.clear(count);
    await user.type(count, schedule.end.kind === 'after_count' ? String(schedule.end.count) : '');
    await user.type(within(dialog).getByLabelText('Название встречи'), template.title);
    for (const member of attendees) await user.click(within(dialog).getByRole('checkbox', { name: member.displayName }));
    await user.click(within(dialog).getByRole('checkbox', { name: periodChoice(PERIOD_A) }));

    await user.click(within(dialog).getByRole('button', { name: 'Проверить расписание' }));
    const createButton = within(dialog).getByRole('button', { name: 'Создать серию' });
    await waitFor(() => expect(createButton).toBeEnabled());
    expect(previews()).toHaveLength(1);
    expect(previews()[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(previews()[0]?.body).toEqual(expectedPreview);
    expect(writes()).toEqual([]);

    // The create answer is lost; closing and reopening shows the submitted snapshot, read-only.
    await user.click(createButton);
    await waitFor(() => expect(state.createAttempts).toBe(1));
    await act(async () => {
      lostCreate.resolve(undefined);
    });
    await within(dialog).findByRole('button', { name: 'Повторить создание серии' });
    await close(user, 'Новая серия встреч');
    await user.click(await within(panel).findByRole('button', { name: 'Открыть отправку' }));
    dialog = await screen.findByRole('dialog', { name: 'Новая серия встреч' });
    const title = within(dialog).getByLabelText('Название встречи');
    expect(title).toHaveValue(template.title);
    expect(title).toBeDisabled();
    const chosenPeriod = within(dialog).getByRole('checkbox', { name: periodChoice(PERIOD_A) });
    expect(chosenPeriod).toBeChecked();
    expect(chosenPeriod).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: periodChoice(PERIOD_B) })).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Вторник' })).not.toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Повторить создание серии' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Новая серия встреч' })).not.toBeInTheDocument());
    const creates = writes();
    expect(creates).toHaveLength(2);
    const createKey = creates[0]?.headers.get('Idempotency-Key') ?? '';
    expect(isUuid(createKey)).toBe(true);
    for (const write of creates) {
      expect(`${write.method} ${write.path}`).toBe(`POST ${seriesListPath}`);
      expect(write.headers.get('Idempotency-Key')).toBe(createKey);
      expect(write.body).toEqual(createRecurrenceSeriesInputSchema.parse(createInput(HASH_A, expectedPreview)));
    }

    // Reserved headers have no meeting identity, so nothing can be opened yet.
    let table = await within(panel).findByRole('table', { name: 'Встречи серии в периоде' }, { timeout: 5000 });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).queryAllByRole('button', { name: /^Открыть встречу/ })).toEqual([]);

    // One explicit chunk for the selected period; the authoritative reread shows the prepared occurrence.
    const prepare = await within(panel).findByRole('button', { name: 'Подготовить встречи периода' });
    expect(writes()).toHaveLength(2);
    await user.click(prepare);
    const open = await within(panel).findByRole('button', { name: `Открыть встречу ${preparedHeader.occurrenceKey}` });
    table = within(panel).getByRole('table', { name: 'Встречи серии в периоде' });
    expect(within(table).getAllByRole('button', { name: /^Открыть встречу/ })).toEqual([open]);
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Подготовить встречи периода' })).not.toBeInTheDocument());
    const sent = writes();
    expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${seriesListPath}`,
      `POST ${seriesListPath}`,
      `POST ${materializePath(PERIOD_A)}`,
    ]);
    const chunk = sent[2];
    expect(chunk?.body).toEqual({ limit: 100 });
    const chunkKey = chunk?.headers.get('Idempotency-Key') ?? '';
    expect(isUuid(chunkKey)).toBe(true);
    expect(chunkKey).not.toBe(createKey);

    // The prepared meeting opens in its original period, from the real locator the server returned.
    await user.click(open);
    const drawer = await screen.findByRole('dialog', { name: meetingTask.title });
    expect(await within(drawer).findByRole('tab', { name: 'Встреча' })).toBeInTheDocument();
    expect(within(drawer).queryByRole('heading', { name: 'Встреча относится к другому периоду' })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === 'GET' && call.path === `${rootPath}/tasks/${MEETING_TASK_ID}/meeting`)).toBe(true);
    expect(writes()).toHaveLength(3);
  });

  it('restarts explicitly from the first chunk after a confirmed 400 rejects the stored continuation', async () => {
    let attempts = 0;
    const { calls } = installFakeApi({
      ...tableRoutes(),
      [`GET ${seriesListPath}`]: () => ok([series()]),
      [`GET ${seriesPath}`]: () => ok(series()),
      [`GET ${readinessPath(PERIOD_A)}`]: () => ok(readiness(PERIOD_A, attempts >= 3 ? 0 : 1)),
      [`GET ${instancesPath()}`]: () => ok(headers(false)),
      [`POST ${materializePath(PERIOD_A)}`]: () => {
        attempts += 1;
        if (attempts === 2) return failure(400, 'VALIDATION_FAILED', 'Invalid old cursor');
        return ok(materialization(PERIOD_A, { createdCount: 0, remainingCount: attempts >= 3 ? 0 : 1, nextCursor: attempts >= 3 ? null : 'old-process-signed-cursor' }));
      },
    });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&series=${SERIES_ID}`);
    const panel = await screen.findByRole('region', { name: 'Повторяющиеся встречи' });
    await user.click(await within(panel).findByRole('button', { name: 'Подготовить встречи периода' }));
    await user.click(await within(panel).findByRole('button', { name: 'Продолжить подготовку встреч' }));
    await within(panel).findByText(/Продолжение прошлой подготовки устарело/);
    await user.click(within(panel).getByRole('button', { name: 'Подготовить встречи периода' }));
    await waitFor(() => expect(attempts).toBe(3));
    const writes = calls.filter(call => call.method === 'POST' && call.path === materializePath(PERIOD_A));
    expect(writes.map(call => call.body)).toEqual([{ limit: 100 }, { limit: 100, cursor: 'old-process-signed-cursor' }, { limit: 100 }]);
    expect(writes[2]?.headers.get('Idempotency-Key')).not.toBe(writes[1]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Подготовить встречи периода' })).not.toBeInTheDocument());
  });

  it('previews and applies skip and restore to the stable reserved instance without inventing a task', async () => {
    let current = instance(preparedKey ?? '', { ordinal: 1 });
    const { calls } = installFakeApi({
      ...tableRoutes(),
      [`GET ${seriesListPath}`]: () => ok([series()]),
      [`GET ${seriesPath}`]: () => ok(series()),
      [`GET ${readinessPath(PERIOD_A)}`]: () => ok(readiness(PERIOD_A, current.calendarState === 'cancelled' ? 0 : 1)),
      [`GET ${instancesPath()}`]: () => ok([current]),
      [`POST ${rootPath}/recurrence-series/${SERIES_ID}/instances/${current.occurrenceKey}/exception-preview`]: request => {
        const input = request.body as { kind: 'skip' | 'restore' };
        return ok({ seriesId: SERIES_ID, instanceId: current.id, occurrenceKey: current.occurrenceKey, previewHash: HASH_A, kind: input.kind, before: current.resolution, after: input.kind === 'skip' ? null : current.resolution, calendarStateAfter: input.kind === 'skip' ? 'cancelled' : 'scheduled', protectedReasons: [], beforePlannedCalendar: plannedCalendar(), afterPlannedCalendar: plannedCalendar() });
      },
      [`POST ${rootPath}/recurrence-series/${SERIES_ID}/instances/${current.occurrenceKey}/exception`]: request => {
        const input = request.body as { kind: 'skip' | 'restore'; reason: string };
        current = { ...current, revision: current.revision + 1, calendarState: input.kind === 'skip' ? 'cancelled' : 'scheduled', exception: { versionId: 'ac800000-0000-4000-8000-000000000001', revision: current.revision, kind: input.kind, reason: input.reason, actorUserId: anna.id, recordedAt: STAMP } };
        return ok(current);
      },
    });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&series=${SERIES_ID}`);
    const panel = await screen.findByRole('region', { name: 'Повторяющиеся встречи' });
    for (const [kind, reason, revision] of [['skip', 'Не проводим в праздник', 1], ['restore', 'Возвращаем дату в расписание', 2]] as const) {
      await user.click(await within(panel).findByRole('button', { name: `Изменить встречу ${current.occurrenceKey}` }));
      const dialog = await screen.findByRole('dialog', { name: 'Изменить одну встречу' });
      expect(within(dialog).getByLabelText('Действие со встречей')).toHaveValue(kind);
      expect(within(dialog).getByRole('button', { name: 'Применить изменение' })).toBeDisabled();
      await user.type(within(dialog).getByLabelText('Причина изменения'), reason);
      await user.click(within(dialog).getByRole('button', { name: 'Проверить изменение' }));
      const apply = within(dialog).getByRole('button', { name: 'Применить изменение' });
      await waitFor(() => expect(apply).toBeEnabled());
      await user.click(apply);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Изменить одну встречу' })).not.toBeInTheDocument());
      const command = calls.filter(call => call.path.endsWith('/exception')).at(-1);
      expect(command?.body).toEqual({ expectedSeriesRevision: 1, expectedInstanceRevision: revision, reason, kind, previewHash: HASH_A });
      expect(isUuid(command?.headers.get('Idempotency-Key') ?? '')).toBe(true);
      expect(current.taskId).toBeNull();
      await within(panel).findByText(kind === 'skip' ? 'Отменена до подготовки' : 'Ещё не подготовлена');
    }
    expect(calls.filter(call => call.method === 'POST').map(call => call.path.split('/').at(-1))).toEqual(['exception-preview', 'exception', 'exception-preview', 'exception']);
  });

  it.each(['series list', 'readiness'] as const)('hides loaded recurrence data after an authoritative %s denial on refetch', async (target) => {
    const shown = series();
    const deny = { active: false };
    const forbidden = () => failure(403, 'FORBIDDEN', 'Sensitive server text');
    const { calls } = installFakeApi({
      ...tableRoutes(),
      [`GET ${seriesListPath}`]: () => (deny.active && target === 'series list' ? forbidden() : ok([shown])),
      [`GET ${seriesPath}`]: () => ok(shown),
      [`GET ${readinessPath(PERIOD_A)}`]: () => (deny.active && target === 'readiness' ? forbidden() : ok(readiness(PERIOD_A, 1))),
      [`GET ${instancesPath()}`]: () => ok(headers(false)),
    });
    const { queryClient } = renderApp(`${weekPath}?period=${PERIOD_A}&series=${SERIES_ID}`);

    const panel = await screen.findByRole('region', { name: 'Повторяющиеся встречи' }, { timeout: 5000 });
    await within(panel).findByRole('table', { name: 'Встречи серии в периоде' }, { timeout: 5000 });
    const card = within(panel).getByRole('region', { name: 'Встречи серий в периоде' });
    await within(card).findByRole('button', { name: 'Подготовить встречи периода' });
    expect(within(panel).getByText(shown.currentVersion.template.title)).toBeInTheDocument();
    expect(within(card).getAllByRole('term').length).toBeGreaterThan(0);

    deny.active = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: recurrenceKeys.root(anna.id, alpha.id) });
    });

    if (target === 'series list') {
      await waitFor(() => expect(within(panel).queryByText(shown.currentVersion.template.title)).not.toBeInTheDocument());
      expect(within(panel).queryByRole('combobox')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('region', { name: 'Встречи серий в периоде' })).not.toBeInTheDocument();
    } else {
      await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Подготовить встречи периода' })).not.toBeInTheDocument());
      const deniedCard = within(panel).getByRole('region', { name: 'Встречи серий в периоде' });
      expect(within(deniedCard).queryAllByRole('term')).toEqual([]);
      expect(within(deniedCard).queryAllByRole('listitem')).toEqual([]);
    }
    expect(within(panel).queryByRole('button', { name: 'Подготовить встречи периода' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Sensitive server text');
    expect(writesOf(calls)).toEqual([]);
  });
});
