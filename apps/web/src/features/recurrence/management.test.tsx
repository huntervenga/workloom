import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  editRecurrenceSeriesInputSchema,
  recurrenceEditPreviewInputSchema,
  recurrenceEditPreviewSchema,
  recurrenceExceptionPreviewSchema,
  recurrenceInstanceSchema,
  recurrencePeriodPreviewSchema,
  recurrenceSeriesSchema,
  setRecurrenceExceptionInputSchema,
  type RecurrenceEditPreviewDto,
  type RecurrenceExceptionKind,
  type RecurrenceExceptionPreviewDto,
  type RecurrenceInstanceDto,
  type RecurrencePeriodPreviewDto,
  type RecurrenceProtectedReason,
  type RecurrenceSeriesDto,
} from '@workloom/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { isUuid } from '../../lib/format';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, deferred, failure, installFakeApi, ok, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { PERIOD_A, PERIOD_B, PROJECT_ID, rootPath } from '../planning/test/fixtures';
import { HASH_A, HASH_B, SERIES_B_ID, SERIES_ID, createPreviewInput, instance, series, plannedCalendar } from './test/fixtures';
import {
  recurrenceDraftHeld,
  recurrenceEditVariables,
  recurrenceExceptionVariables,
  recurrenceManagementKey,
  recurrencePeriodVariables,
  type RecurrenceManagedSession,
} from './useRecurrenceManagement';
import { useRecurrenceWorkspace } from './useRecurrenceWorkspace';

/*
 * Page-owned management drafts (edit, add periods, per-instance exceptions) through the real
 * useRecurrenceWorkspace, its command hooks and a real QueryClient. Only fetch is replaced.
 */

type Answer = (request: FakeRequest) => Response | Promise<Response>;
type View = ReturnType<typeof renderWorkspace>;

const PERIOD_C = 'f0000000-0000-4000-8000-000000000003';
const OTHER_PROJECT = 'e0000000-0000-4000-8000-000000000099';
const HASH_C = 'c'.repeat(64);
const EFFECTIVE = '2026-10-21';
const seriesPathOf = (id: string) => `${rootPath}/recurrence-series/${id}`;
const instancePathOf = (target: RecurrenceInstanceDto) => `${seriesPathOf(target.seriesId)}/instances/${target.occurrenceKey}`;

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function renderWorkspace() {
  const client = createQueryClient({ retry: false });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useRecurrenceWorkspace(anna.id, alpha.id, PROJECT_ID), { wrapper });
}

const m = (view: View) => view.result.current.management;

/** Each queued route answers in order; an unplanned extra request gets a 500 and shows in the call log. */
function server(queues: Record<string, Answer[]>) {
  const table: RouteTable = {};
  for (const [route, answers] of Object.entries(queues)) {
    table[route] = (request) => answers.shift()?.(request) ?? failure(500, 'UNPLANNED_REQUEST', 'No answer queued');
  }
  const { calls } = installFakeApi(table);
  return {
    calls,
    previews: () => calls.filter((call) => call.path.endsWith('-preview')),
    writes: () => calls.filter((call) => call.method !== 'GET' && !call.path.endsWith('-preview')),
  };
}

function lostAfter(gate: ReturnType<typeof deferred<undefined>>): Answer {
  return async () => {
    await gate.promise;
    throw new TypeError('Failed to fetch');
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((done) => setTimeout(done, 0));
  });
}

function retained<S>(sessions: Readonly<Record<string, S>>, id: string): S {
  const session = sessions[recurrenceManagementKey(id)];
  if (session === undefined) throw new Error(`Expected a retained draft for ${id}.`);
  return session;
}
const editOf = (view: View, seriesId: string) => retained(m(view).edits, seriesId);
const periodsOf = (view: View, seriesId: string) => retained(m(view).periodSessions, seriesId);
const exceptionOf = (view: View, instanceId: string) => retained(m(view).exceptions, instanceId);

function seriesAt(revision: number, id = SERIES_ID, periods: string[] = [PERIOD_A]): RecurrenceSeriesDto {
  return recurrenceSeriesSchema.parse({ ...series(createPreviewInput(periods), id), revision });
}

function editPreview(seriesRevision: number, previewHash: string): RecurrenceEditPreviewDto {
  return recurrenceEditPreviewSchema.parse({
    seriesId: SERIES_ID,
    seriesRevision,
    effectiveFromNominalDate: EFFECTIVE,
    previewHash,
    counts: { nominalCount: 4, consumedNominalCount: 1, remainingNominalCount: 3, skippedCount: 0, cancelledCount: 0 },
    impacts: [],
    protectedTargets: [],
  });
}

function periodPreview(periodIds: string[], previewHash: string): RecurrencePeriodPreviewDto {
  return recurrencePeriodPreviewSchema.parse({
    seriesId: SERIES_ID,
    seriesRevision: 1,
    previewHash,
    periods: periodIds.map((periodId) => ({ periodId, periodRevision: 1, candidateCount: 0 })),
    candidates: [],
  });
}

function exceptionPreview(
  target: RecurrenceInstanceDto,
  kind: RecurrenceExceptionKind,
  previewHash: string,
  protectedReasons: RecurrenceProtectedReason[] = [],
): RecurrenceExceptionPreviewDto {
  return recurrenceExceptionPreviewSchema.parse({
    seriesId: target.seriesId,
    instanceId: target.id,
    occurrenceKey: target.occurrenceKey,
    previewHash,
    kind,
    before: target.resolution,
    after: kind === 'skip' ? null : target.resolution,
    calendarStateAfter: kind === 'skip' ? 'cancelled' : 'scheduled',
    protectedReasons,
    beforePlannedCalendar: plannedCalendar(),
    afterPlannedCalendar: plannedCalendar(),
  });
}

describe('recurrence management drafts', () => {
  it('keeps untouched drafts clean and retains typed edit, period and exception drafts across close, another selection and reopen', () => {
    const { calls } = server({});
    const view = renderWorkspace();
    const seriesA = seriesAt(1);
    const seriesB = seriesAt(1, SERIES_B_ID, [PERIOD_B]);
    const target = instance('2026-10-21', { ordinal: 2 });

    act(() => m(view).openEdit(seriesA));
    act(() => m(view).openPeriods(seriesB));
    act(() => m(view).openException(seriesA, target, 'skip'));
    expect(m(view).dirty).toBe(false);
    const edit = editOf(view, SERIES_ID);
    const periods = periodsOf(view, SERIES_B_ID);
    const exception = exceptionOf(view, target.id);
    expect(edit.effectiveFromNominalDate).toBe('');
    expect(periods.periodIds).toEqual([]);
    expect(exception.reason).toBe('');

    act(() => m(view).changeEdit(edit.id, { effectiveFromNominalDate: EFFECTIVE, template: { ...edit.template, title: 'Новая повестка' } }));
    expect(m(view).dirty).toBe(true);
    act(() => m(view).changePeriods(periods.id, [PERIOD_A]));
    act(() => m(view).changeException(exception.id, { reason: 'Праздник' }));
    act(() => {
      m(view).close();
      view.result.current.setSelectedSeriesId(SERIES_B_ID);
    });
    expect(m(view).active).toBeNull();

    // Reopening with newer server data neither reseeds nor silently rebases a retained draft.
    act(() => m(view).openEdit(seriesAt(2)));
    const reopenedEdit = editOf(view, SERIES_ID);
    expect(m(view).active).toEqual({ kind: 'edit', session: reopenedEdit });
    expect(reopenedEdit.id).toBe(edit.id);
    expect(reopenedEdit.base.revision).toBe(1);
    expect(reopenedEdit.effectiveFromNominalDate).toBe(EFFECTIVE);
    expect(reopenedEdit.template.title).toBe('Новая повестка');

    act(() => m(view).openPeriods(seriesB));
    expect(periodsOf(view, SERIES_B_ID)).toMatchObject({ id: periods.id, periodIds: [PERIOD_A] });
    // A retained exception keeps its own action; the opener's kind applies only to a new draft.
    act(() => m(view).openException(seriesA, target, 'move'));
    expect(exceptionOf(view, target.id)).toMatchObject({ id: exception.id, kind: 'skip', reason: 'Праздник' });
    expect(m(view).dirty).toBe(true);
    expect(calls).toEqual([]);
  });

  interface StaleCase {
    mode: string;
    previewRoute: string;
    /** Opens a draft for series A and makes it build; returns its draft ID. */
    prepare: (view: View) => string;
    check: (view: View, id: string) => void;
    change: (view: View, id: string) => void;
    session: (view: View) => RecurrenceManagedSession<unknown, unknown>;
    submittable: (view: View) => { input: { previewHash: string } } | null;
    answer: (previewHash: string, changed: boolean) => unknown;
  }
  const target = instance('2026-10-21', { ordinal: 2 });
  const staleCases: StaleCase[] = [
    {
      mode: 'edit',
      previewRoute: `${seriesPathOf(SERIES_ID)}/edit-preview`,
      prepare: (view) => {
        act(() => m(view).openEdit(seriesAt(1)));
        const id = editOf(view, SERIES_ID).id;
        act(() => m(view).changeEdit(id, { effectiveFromNominalDate: EFFECTIVE }));
        return id;
      },
      check: (view, id) => m(view).checkEdit(id),
      change: (view, id) => m(view).changeEdit(id, { template: { ...editOf(view, SERIES_ID).template, title: 'Новая повестка' } }),
      session: (view) => editOf(view, SERIES_ID),
      submittable: (view) => recurrenceEditVariables(editOf(view, SERIES_ID)),
      answer: (previewHash) => editPreview(1, previewHash),
    },
    {
      mode: 'periods',
      previewRoute: `${seriesPathOf(SERIES_ID)}/period-preview`,
      prepare: (view) => {
        act(() => m(view).openPeriods(seriesAt(1)));
        const id = periodsOf(view, SERIES_ID).id;
        act(() => m(view).changePeriods(id, [PERIOD_B]));
        return id;
      },
      check: (view, id) => m(view).checkPeriods(id),
      change: (view, id) => m(view).changePeriods(id, [PERIOD_B, PERIOD_C]),
      session: (view) => periodsOf(view, SERIES_ID),
      submittable: (view) => recurrencePeriodVariables(periodsOf(view, SERIES_ID)),
      answer: (previewHash, changed) => periodPreview(changed ? [PERIOD_B, PERIOD_C] : [PERIOD_B], previewHash),
    },
    {
      mode: 'exception',
      previewRoute: `${instancePathOf(target)}/exception-preview`,
      prepare: (view) => {
        act(() => m(view).openException(seriesAt(1), target, 'skip'));
        const id = exceptionOf(view, target.id).id;
        act(() => m(view).changeException(id, { reason: 'Праздник' }));
        return id;
      },
      check: (view, id) => m(view).checkException(id),
      change: (view, id) => m(view).changeException(id, { reason: 'Перенос планёрки' }),
      session: (view) => exceptionOf(view, target.id),
      submittable: (view) => recurrenceExceptionVariables(exceptionOf(view, target.id)),
      answer: (previewHash) => exceptionPreview(target, 'skip', previewHash),
    },
  ];
  it.each(staleCases)('drops a late $mode preview answered after the draft changed; only a fresh check is submittable', async (c) => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    const { previews, writes } = server({ [`POST ${c.previewRoute}`]: [() => stale.promise, () => fresh.promise] });
    const view = renderWorkspace();
    const id = c.prepare(view);

    act(() => c.check(view, id));
    await waitFor(() => expect(previews()).toHaveLength(1));
    act(() => c.change(view, id));
    await act(async () => {
      stale.resolve(ok(c.answer(HASH_A, false)));
    });
    await settle();
    expect(c.session(view).preview).toBeNull();
    expect(c.session(view).previewInput).toBeNull();
    expect(c.submittable(view)).toBeNull();

    act(() => c.check(view, id));
    await act(async () => {
      fresh.resolve(ok(c.answer(HASH_B, true)));
    });
    await waitFor(() => expect(c.session(view).preview).not.toBeNull());
    expect(c.submittable(view)?.input.previewHash).toBe(HASH_B);
    expect(c.session(view).previewInput).toEqual(previews()[1]?.body);
    expect(previews()[1]?.body).not.toEqual(previews()[0]?.body);
    expect(previews().map((call) => call.headers.get('Idempotency-Key'))).toEqual([null, null]);
    expect(writes()).toEqual([]);
  });
});

describe('recurrence management success cleanup', () => {
  it('a lost edit retried from the hook retires only its original draft while another series draft stays open', async () => {
    const gate = deferred<undefined>();
    const confirmed = seriesAt(2);
    const { writes } = server({
      [`POST ${seriesPathOf(SERIES_ID)}/edit-preview`]: [() => ok(editPreview(1, HASH_A))],
      [`POST ${seriesPathOf(SERIES_ID)}/edit`]: [lostAfter(gate), () => ok(confirmed)],
    });
    const view = renderWorkspace();
    act(() => m(view).openEdit(seriesAt(1)));
    const draftA = editOf(view, SERIES_ID);
    act(() => m(view).changeEdit(draftA.id, { effectiveFromNominalDate: EFFECTIVE, template: { ...draftA.template, title: 'Новая повестка' } }));
    act(() => m(view).checkEdit(draftA.id));
    await waitFor(() => expect(editOf(view, SERIES_ID).preview).not.toBeNull());
    const variables = recurrenceEditVariables(editOf(view, SERIES_ID));
    if (variables === null) throw new Error('Expected submittable edit variables.');

    act(() => view.result.current.commands.edit.mutate(variables));
    await act(async () => {
      gate.resolve(undefined);
    });
    await waitFor(() => expect(view.result.current.commands.edit.uncertain?.variables).toEqual(variables));
    let discarded = true;
    act(() => {
      discarded = m(view).discard('edit', draftA.id, recurrenceDraftHeld(view.result.current.commands.edit, draftA.id));
    });
    expect(discarded).toBe(false);

    // The page moves on to series B and opens its own typed edit draft.
    act(() => {
      m(view).close();
      view.result.current.setSelectedSeriesId(SERIES_B_ID);
      m(view).openEdit(seriesAt(1, SERIES_B_ID, [PERIOD_B]));
    });
    const draftB = editOf(view, SERIES_B_ID);
    act(() => m(view).changeEdit(draftB.id, { template: { ...draftB.template, title: 'Черновик серии Б' } }));
    const retainedB = editOf(view, SERIES_B_ID);

    // Explicit global retry; no dialog callback is attached.
    act(() => view.result.current.commands.edit.retryUncertain());
    await waitFor(() => expect(m(view).edits[recurrenceManagementKey(SERIES_ID)]).toBeUndefined());
    expect(view.result.current.commands.edit.uncertain).toBeNull();
    expect(m(view).edits[recurrenceManagementKey(SERIES_B_ID)]).toEqual(retainedB);
    expect(m(view).active).toEqual({ kind: 'edit', session: retainedB });
    expect(view.result.current.selectedSeriesId).toBe(SERIES_B_ID);

    const sent = writes();
    expect(sent).toHaveLength(2);
    const key = sent[0]?.headers.get('Idempotency-Key') ?? '';
    expect(isUuid(key)).toBe(true);
    for (const write of sent) {
      expect(`${write.method} ${write.path}`).toBe(`POST ${seriesPathOf(SERIES_ID)}/edit`);
      expect(write.headers.get('Idempotency-Key')).toBe(key);
      expect(write.body).toEqual(editRecurrenceSeriesInputSchema.parse(variables.input));
      expect(write.body).toMatchObject({ expectedRevision: 1, effectiveFromNominalDate: EFFECTIVE, previewHash: HASH_A });
      expect(write.body).not.toHaveProperty('draftId');
    }
  });

  it('a lost exception retried from the hook retires only its instance draft; a sibling header of the same period keeps its own', async () => {
    const first = instance('2026-10-19', { ordinal: 1 });
    const second = instance('2026-10-21', { ordinal: 2 });
    expect(first.id).not.toBe(second.id);
    expect(first.plannedPeriodId).toBe(second.plannedPeriodId);
    const cancelledFirst = recurrenceInstanceSchema.parse({ ...instance(first.occurrenceKey, { ordinal: 1, cancelled: true }), revision: 2 });
    const gate = deferred<undefined>();
    const { writes } = server({
      [`POST ${instancePathOf(first)}/exception-preview`]: [() => ok(exceptionPreview(first, 'skip', HASH_A))],
      [`POST ${instancePathOf(first)}/exception`]: [lostAfter(gate), () => ok(cancelledFirst)],
    });
    const view = renderWorkspace();
    const seriesA = seriesAt(1);
    act(() => m(view).openException(seriesA, first, 'skip'));
    const draftA = exceptionOf(view, first.id);
    act(() => m(view).changeException(draftA.id, { reason: 'Праздник' }));
    act(() => m(view).checkException(draftA.id));
    await waitFor(() => expect(exceptionOf(view, first.id).preview).not.toBeNull());
    const variables = recurrenceExceptionVariables(exceptionOf(view, first.id));
    if (variables === null) throw new Error('Expected submittable exception variables.');

    act(() => view.result.current.commands.exception.mutate(variables));
    await act(async () => {
      gate.resolve(undefined);
    });
    await waitFor(() => expect(view.result.current.commands.exception.uncertain?.variables).toEqual(variables));
    // The held command is addressed by the stable occurrence and carries its reason.
    expect(view.result.current.commands.exception.uncertain?.variables).toMatchObject({
      draftId: draftA.id,
      seriesId: SERIES_ID,
      occurrenceKey: first.occurrenceKey,
      input: { kind: 'skip', reason: 'Праздник', previewHash: HASH_A },
    });

    act(() => m(view).openException(seriesA, second, 'skip'));
    const draftB = exceptionOf(view, second.id);
    act(() => m(view).changeException(draftB.id, { reason: 'Отпуск ведущего' }));
    const retainedB = exceptionOf(view, second.id);

    act(() => view.result.current.commands.exception.retryUncertain());
    await waitFor(() => expect(m(view).exceptions[recurrenceManagementKey(first.id)]).toBeUndefined());
    expect(view.result.current.commands.exception.uncertain).toBeNull();
    expect(m(view).exceptions[recurrenceManagementKey(second.id)]).toEqual(retainedB);
    expect(m(view).active).toEqual({ kind: 'exception', session: retainedB });

    const sent = writes();
    expect(sent).toHaveLength(2);
    const key = sent[0]?.headers.get('Idempotency-Key') ?? '';
    expect(isUuid(key)).toBe(true);
    for (const write of sent) {
      expect(`${write.method} ${write.path}`).toBe(`POST ${instancePathOf(first)}/exception`);
      expect(write.headers.get('Idempotency-Key')).toBe(key);
      expect(write.body).toEqual(
        setRecurrenceExceptionInputSchema.parse({ expectedSeriesRevision: 1, expectedInstanceRevision: 1, kind: 'skip', reason: 'Праздник', previewHash: HASH_A }),
      );
    }
  });
});

describe('recurrence management rebase', () => {
  it('rebases an edit only explicitly after a confirmed conflict, keeping typed input and requiring a fresh guarded preview', async () => {
    const opened = seriesAt(2);
    const fresh = seriesAt(3);
    const editAnswer = deferred<Response>();
    const late = deferred<Response>();
    const { previews, writes } = server({
      [`POST ${seriesPathOf(SERIES_ID)}/edit-preview`]: [() => ok(editPreview(2, HASH_A)), () => late.promise, () => ok(editPreview(3, HASH_B))],
      [`POST ${seriesPathOf(SERIES_ID)}/edit`]: [() => editAnswer.promise],
    });
    const view = renderWorkspace();
    act(() => m(view).openEdit(opened));
    const draft = editOf(view, SERIES_ID);
    act(() => m(view).changeEdit(draft.id, { effectiveFromNominalDate: EFFECTIVE, template: { ...draft.template, title: 'Новая повестка' } }));
    act(() => m(view).checkEdit(draft.id));
    await waitFor(() => expect(editOf(view, SERIES_ID).preview).not.toBeNull());
    const variables = recurrenceEditVariables(editOf(view, SERIES_ID));
    if (variables === null) throw new Error('Expected submittable edit variables.');
    act(() => view.result.current.commands.edit.mutate(variables));
    await waitFor(() => expect(view.result.current.commands.edit.pendingCommand).not.toBeNull());

    // While its command is in flight, the real held state refuses a rebase.
    let rebased = true;
    act(() => {
      rebased = m(view).rebaseEdit(draft.id, fresh, recurrenceDraftHeld(view.result.current.commands.edit, draft.id));
    });
    expect(rebased).toBe(false);
    expect(editOf(view, SERIES_ID).base).toEqual(opened);

    await act(async () => {
      editAnswer.resolve(failure(409, 'REVISION_CONFLICT', 'Series changed'));
    });
    await waitFor(() => expect(view.result.current.commands.edit.error).toMatchObject({ kind: 'conflict' }));
    expect(view.result.current.commands.edit.uncertain).toBeNull();
    expect(recurrenceDraftHeld(view.result.current.commands.edit, draft.id)).toBe(false);
    const typed = editOf(view, SERIES_ID);

    // A check sent against the old base is still running when the rebase lands.
    act(() => m(view).checkEdit(draft.id));
    await waitFor(() => expect(previews()).toHaveLength(2));
    const foreign = [seriesAt(3, SERIES_B_ID), recurrenceSeriesSchema.parse({ ...fresh, projectId: OTHER_PROJECT }), seriesAt(1)];
    for (const candidate of foreign) {
      act(() => {
        rebased = m(view).rebaseEdit(draft.id, candidate, false);
      });
      expect(rebased).toBe(false);
      expect(editOf(view, SERIES_ID).base).toEqual(opened);
    }
    act(() => {
      rebased = m(view).rebaseEdit(draft.id, fresh, recurrenceDraftHeld(view.result.current.commands.edit, draft.id));
    });
    expect(rebased).toBe(true);
    // Only the base changes: draft ID, raw typed values and pristine stay; the old preview and check go.
    expect(editOf(view, SERIES_ID)).toEqual({ ...typed, base: fresh, preview: null, previewInput: null, check: null });
    expect(m(view).dirty).toBe(true);
    expect(recurrenceEditVariables(editOf(view, SERIES_ID))).toBeNull();

    await act(async () => {
      late.resolve(ok(editPreview(2, HASH_C)));
    });
    await settle();
    expect(editOf(view, SERIES_ID).preview).toBeNull();

    act(() => m(view).checkEdit(draft.id));
    await waitFor(() => expect(editOf(view, SERIES_ID).preview?.previewHash).toBe(HASH_B));
    const firstSent = recurrenceEditPreviewInputSchema.parse(previews()[0]?.body);
    expect(previews()[2]?.body).toEqual({ ...firstSent, expectedRevision: 3 });
    expect(recurrenceEditVariables(editOf(view, SERIES_ID))).toEqual({
      draftId: draft.id,
      seriesId: SERIES_ID,
      input: { ...firstSent, expectedRevision: 3, previewHash: HASH_B },
    });
    // Nothing was resent automatically after the conflict.
    expect(writes()).toHaveLength(1);
  });

  it('never makes a protected exception preview submittable, and rebases an exception only onto the same stable header', async () => {
    const target = instance('2026-10-19', { ordinal: 1 });
    const freshTarget = recurrenceInstanceSchema.parse({ ...target, revision: 2 });
    const { previews, writes } = server({
      [`POST ${instancePathOf(target)}/exception-preview`]: [
        () => ok(exceptionPreview(target, 'skip', HASH_A, ['past'])),
        () => ok(exceptionPreview(freshTarget, 'skip', HASH_B)),
      ],
    });
    const view = renderWorkspace();
    const seriesA = seriesAt(1);
    act(() => m(view).openException(seriesA, target, 'skip'));
    const draft = exceptionOf(view, target.id);
    act(() => m(view).changeException(draft.id, { reason: 'Праздник' }));
    act(() => m(view).checkException(draft.id));
    await waitFor(() => expect(exceptionOf(view, target.id).preview?.protectedReasons).toEqual(['past']));
    // The protected preview stays visible for the exact input but cannot become a command.
    expect(exceptionOf(view, target.id).previewInput).toEqual(previews()[0]?.body);
    expect(recurrenceExceptionVariables(exceptionOf(view, target.id))).toBeNull();

    const sibling = instance('2026-10-21', { ordinal: 2 });
    const movedToOtherPeriod = recurrenceInstanceSchema.parse({ ...freshTarget, plannedPeriodId: PERIOD_B });
    const rekeyed = recurrenceInstanceSchema.parse({ ...freshTarget, occurrenceKey: sibling.occurrenceKey });
    let rebased = true;
    for (const candidate of [sibling, movedToOtherPeriod, rekeyed]) {
      act(() => {
        rebased = m(view).rebaseException(draft.id, seriesA, candidate, false);
      });
      expect(rebased).toBe(false);
      expect(exceptionOf(view, target.id).baseInstance).toEqual(target);
    }
    act(() => {
      rebased = m(view).rebaseException(draft.id, seriesA, freshTarget, recurrenceDraftHeld(view.result.current.commands.exception, draft.id));
    });
    expect(rebased).toBe(true);
    expect(exceptionOf(view, target.id)).toMatchObject({ id: draft.id, kind: 'skip', reason: 'Праздник', preview: null, previewInput: null });

    act(() => m(view).checkException(draft.id));
    await waitFor(() => expect(exceptionOf(view, target.id).preview?.previewHash).toBe(HASH_B));
    expect(previews()[1]?.path).toBe(`${instancePathOf(target)}/exception-preview`);
    expect(previews()[1]?.body).toEqual({ expectedSeriesRevision: 1, expectedInstanceRevision: 2, reason: 'Праздник', kind: 'skip' });
    expect(recurrenceExceptionVariables(exceptionOf(view, target.id))).toEqual({
      draftId: draft.id,
      seriesId: SERIES_ID,
      occurrenceKey: target.occurrenceKey,
      input: { expectedSeriesRevision: 1, expectedInstanceRevision: 2, reason: 'Праздник', kind: 'skip', previewHash: HASH_B },
    });
    expect(writes()).toEqual([]);
  });
});
