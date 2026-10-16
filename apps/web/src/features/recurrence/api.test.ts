import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import {
  createRecurrenceSeriesInputSchema,
  recurrenceCreatePreviewInputSchema,
  type RecurrenceCreatePreviewInput,
  type RecurrenceSeriesDto,
} from '@workloom/contracts';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, created, installFakeApi, json, ok } from '../../test/fakeApi';
import { PERIOD_A, PERIOD_B, PROJECT_ID } from '../planning/test/fixtures';
import { fetchRecurrenceInstances, fetchRecurrenceSeries, fetchRecurrenceSeriesDetail, previewRecurrenceCreate } from './api';
import { useRecurrenceCommands } from './queries';
import {
  createInput,
  createPreview,
  createPreviewInput,
  createPreviewPath,
  instance,
  instancesPath,
  scheduleInput,
  series,
  SERIES_B_ID,
  SERIES_ID,
  seriesListPath,
  templateInput,
} from './test/fixtures';

/* P3b recurrence transport through the real api.ts/queries.ts code; only fetch is replaced. */

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function page(data: unknown[], nextCursor: string | null): Response {
  return json(200, { data, meta: { requestId: 'req_test_page', nextCursor } });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the request to be rejected.');
}

function distinctPeriodIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `ab800000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
}

function renderCommands() {
  const client = createQueryClient({ retry: false });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useRecurrenceCommands(anna.id, alpha.id, PROJECT_ID), { wrapper });
}

describe('recurrence collections', () => {
  it('follows the server cursor through every series page with the all-states filter', async () => {
    const first = series();
    const second = series(createPreviewInput([PERIOD_A, PERIOD_B]), SERIES_B_ID);
    const { calls } = installFakeApi({
      [`GET ${seriesListPath}`]: (request) =>
        request.searchParams.get('cursor') === 'cursor_series_2' ? page([second], null) : page([first], 'cursor_series_2'),
    });

    const result = await fetchRecurrenceSeries(alpha.id, PROJECT_ID);

    expect(result).toEqual([first, second]);
    expect(result.map((item) => item.boundPeriodIds)).toEqual([[PERIOD_A], [PERIOD_A, PERIOD_B]]);
    expect(calls.map((call) => Object.fromEntries(call.searchParams))).toEqual([
      { state: 'all', limit: '100' },
      { state: 'all', limit: '100', cursor: 'cursor_series_2' },
    ]);
  });

  it('reads every instance page of the canonical period, cancelled header-only rows included, keeping reserved locators null', async () => {
    const reserved = instance('2026-10-19', { ordinal: 1 });
    const cancelled = instance('2026-10-21', { ordinal: 2, cancelled: true });
    const { calls } = installFakeApi({
      [`GET ${instancesPath()}`]: (request) =>
        request.searchParams.get('cursor') === 'cursor_instances_2' ? page([cancelled], null) : page([reserved], 'cursor_instances_2'),
    });

    const result = await fetchRecurrenceInstances(alpha.id, SERIES_ID, PERIOD_A.toUpperCase());

    expect(result).toEqual([reserved, cancelled]);
    for (const header of result) {
      expect(header).toMatchObject({ meetingId: null, taskId: null, workPackageId: null, meetingRevision: null });
    }
    expect(calls.map((call) => Object.fromEntries(call.searchParams))).toEqual([
      { periodId: PERIOD_A, includeCancelled: 'true', limit: '100' },
      { periodId: PERIOD_A, includeCancelled: 'true', limit: '100', cursor: 'cursor_instances_2' },
    ]);
  });

  it('orders the complete multi-page collection by original series date, independently of UUIDs and moved dates', async () => {
    const monday = instance('2026-10-19', { ordinal: 3 });
    const wednesday = instance('2026-10-21', { ordinal: 2 });
    const friday = instance('2026-10-23', { ordinal: 1 });
    const movedMonday = { ...monday, resolution: { ...monday.resolution, intendedLocalDate: '2026-10-23', resolvedLocalDate: '2026-10-23', resolvedStartAt: '2026-10-23T07:00:00.000Z', resolvedEndAt: '2026-10-23T08:00:00.000Z' } };
    const movedFriday = { ...friday, resolution: { ...friday.resolution, intendedLocalDate: '2026-10-19', resolvedLocalDate: '2026-10-19', resolvedStartAt: '2026-10-19T07:00:00.000Z', resolvedEndAt: '2026-10-19T08:00:00.000Z' } };
    const { calls } = installFakeApi({
      [`GET ${instancesPath()}`]: request => request.searchParams.get('cursor') === 'uuid-page-2'
        ? page([movedMonday], null) : page([movedFriday, wednesday], 'uuid-page-2'),
    });
    const result = await fetchRecurrenceInstances(alpha.id, SERIES_ID, PERIOD_A);
    expect(result.map(item => item.id)).toEqual([monday.id, wednesday.id, friday.id]);
    expect(result.map(item => item.occurrenceKey)).toEqual(['2026-10-19', '2026-10-21', '2026-10-23']);
    expect(result.map(item => item.resolution.resolvedLocalDate)).toEqual(['2026-10-23', '2026-10-21', '2026-10-19']);
    expect(calls.map(call => call.searchParams.get('cursor'))).toEqual([null, 'uuid-page-2']);
  });

  it('rejects an instance whose real locators are only partly present instead of inventing the rest', async () => {
    const partial = { ...instance('2026-10-19', { ordinal: 1, materialized: true }), taskId: null };
    installFakeApi({ [`GET ${instancesPath()}`]: () => page([partial], null) });

    const error = await rejection(fetchRecurrenceInstances(alpha.id, SERIES_ID, PERIOD_A));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'invalid_response' });
  });

  it('treats a repeated cursor as a malformed answer instead of returning a truncated collection', async () => {
    const next: Record<string, string> = { '': 'cursor_1', cursor_1: 'cursor_2', cursor_2: 'cursor_1' };
    const { calls } = installFakeApi({
      [`GET ${instancesPath()}`]: (request) => page([instance('2026-10-19', { ordinal: 1 })], next[request.searchParams.get('cursor') ?? ''] ?? null),
      [`GET ${seriesListPath}`]: () => page([series()], 'cursor_same'),
    });

    const instancesError = await rejection(fetchRecurrenceInstances(alpha.id, SERIES_ID, PERIOD_A));
    const seriesError = await rejection(fetchRecurrenceSeries(alpha.id, PROJECT_ID));

    for (const error of [instancesError, seriesError]) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ kind: 'invalid_response' });
    }
    expect(calls.filter((call) => call.path === instancesPath()).map((call) => call.searchParams.get('cursor'))).toEqual([null, 'cursor_1', 'cursor_2']);
    expect(calls.filter((call) => call.path === seriesListPath).map((call) => call.searchParams.get('cursor'))).toEqual([null, 'cursor_same']);
  });

  const valid = series();
  const malformedSeries: [string, unknown][] = [
    ['omits boundPeriodIds', Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'boundPeriodIds'))],
    ['disagrees with boundPeriodCount', { ...valid, boundPeriodCount: 2 }],
    ['repeats a bound period', { ...valid, boundPeriodIds: [PERIOD_A, PERIOD_A], boundPeriodCount: 2 }],
    ['binds more than 52 periods', { ...valid, boundPeriodIds: distinctPeriodIds(53), boundPeriodCount: 53 }],
    ['starts after 2100', { ...valid, currentVersion: { ...valid.currentVersion, schedule: { ...valid.currentVersion.schedule, startDate: '2101-01-03' } } }],
  ];
  it.each(malformedSeries)('rejects a series answer that %s instead of defaulting it', async (_label, data) => {
    const { calls } = installFakeApi({ [`GET /api/v1/workspaces/${alpha.id}/recurrence-series/${SERIES_ID}`]: () => ok(data) });

    const error = await rejection(fetchRecurrenceSeriesDetail(alpha.id, SERIES_ID));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'invalid_response' });
    expect(calls).toHaveLength(1);
  });
});

describe('recurrence create transport', () => {
  it('sends the create preview as a keyless POST of exactly the validated input', async () => {
    const input = createPreviewInput();
    const answer = createPreview();
    const { calls } = installFakeApi({ [`POST ${createPreviewPath}`]: () => ok(answer) });

    await expect(previewRecurrenceCreate(alpha.id, PROJECT_ID, input)).resolves.toEqual(answer);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('Idempotency-Key')).toBeNull();
    expect(call?.body).toEqual(recurrenceCreatePreviewInputSchema.parse(input));
    // Only the rule and the explicitly chosen period travel: no occurrence dates, hash or extra period.
    expect(call?.body).toEqual({ schedule: scheduleInput(), template: templateInput(), targetPeriodIds: [PERIOD_A] });
  });

  const base = createPreviewInput();
  const invalidPreviews: [string, RecurrenceCreatePreviewInput][] = [
    ['no chosen period', { ...base, targetPeriodIds: [] }],
    ['a repeated period', { ...base, targetPeriodIds: [PERIOD_A, PERIOD_A] }],
    ['53 periods', { ...base, targetPeriodIds: distinctPeriodIds(53) }],
    ['no chosen attendee', { ...base, template: { ...base.template, attendeeMembershipIds: [] } }],
    ['a start date before 2000', { ...base, schedule: { ...base.schedule, startDate: '1999-12-27' } }],
    ['a start date after 2100', { ...base, schedule: { ...base.schedule, startDate: '2101-01-03' } }],
    ['a UI draftId', Object.assign(createPreviewInput(), { draftId: 'draft-a' })],
  ];
  it.each(invalidPreviews)('refuses a preview with %s before sending anything', async (_label, input) => {
    const { calls } = installFakeApi({ [`POST ${createPreviewPath}`]: () => ok(createPreview()) });

    const error = await rejection(previewRecurrenceCreate(alpha.id, PROJECT_ID, input));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it('sends create as a keyed command whose body and request identity exclude the UI draftId', async () => {
    const input = createInput();
    const confirmed = series();
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => created(confirmed),
    ];
    const { calls } = installFakeApi({
      [`POST ${seriesListPath}`]: () => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error('Unexpected extra create request.');
        return answer();
      },
    });
    const { result } = renderCommands();

    // A create without an explicitly chosen period is refused locally; no period is inferred.
    let refused: unknown = null;
    await act(async () => {
      refused = await rejection(result.current.create.mutateAsync({ draftId: 'draft-a', input: { ...input, targetPeriodIds: [] } }));
    });
    expect(refused).toMatchObject({ kind: 'invalid_input' });
    expect(calls).toEqual([]);

    let lost: unknown = null;
    await act(async () => {
      lost = await rejection(result.current.create.mutateAsync({ draftId: 'draft-a', input }));
    });
    expect(lost).toMatchObject({ kind: 'network' });
    expect(result.current.create.uncertain?.variables).toEqual({ draftId: 'draft-a', input });

    // The same input from another UI draft is the same command: draftId is not part of its identity.
    let data: RecurrenceSeriesDto | null = null;
    await act(async () => {
      data = await result.current.create.mutateAsync({ draftId: 'draft-b', input });
    });
    expect(data).toEqual(confirmed);
    expect(result.current.create.uncertain).toBeNull();

    expect(calls).toHaveLength(2);
    const key = calls[0]?.headers.get('Idempotency-Key') ?? '';
    expect(isUuid(key)).toBe(true);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.path).toBe(seriesListPath);
      expect(call.headers.get('Idempotency-Key')).toBe(key);
      expect(call.body).toEqual(createRecurrenceSeriesInputSchema.parse(input));
      expect(call.body).not.toHaveProperty('draftId');
    }
  });
});
