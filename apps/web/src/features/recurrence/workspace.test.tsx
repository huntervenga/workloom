import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRecurrenceSeriesInputSchema, type CreateRecurrenceSeriesInput, type RecurrenceCreatePreviewInput } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { isUuid } from '../../lib/format';
import { canonicalJson } from '../../lib/idempotency';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, created, deferred, failure, installFakeApi, ok, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { PERIOD_A, PERIOD_B, PROJECT_ID } from '../planning/test/fixtures';
import { useRecurrenceReadinessQuery, type CreateSeriesVariables, type MaterializePeriodVariables } from './queries';
import type { RecurrenceRuleDraft } from './RecurrenceRuleFields';
import type { RecurrenceTemplateDraft } from './RecurrenceTemplateFields';
import {
  ATTENDEE_IDS,
  createDefaults,
  createPreview,
  createPreviewInput,
  createPreviewPath,
  HASH_A,
  HASH_B,
  materialization,
  materializePath,
  readiness,
  readinessPath,
  series,
  seriesListPath,
} from './test/fixtures';
import {
  buildRecurrenceCreatePreviewInput,
  newRecurrenceCreateSession,
  useRecurrenceWorkspace,
  type RecurrenceCreateSession,
  type RecurrenceWorkspace,
} from './useRecurrenceWorkspace';

/*
 * The always-mounted recurrence page controller, driven through its real hooks and a real
 * QueryClient. Only fetch is replaced; deferred answers stand in for slow and lost responses.
 */

type Answer = () => Response | Promise<Response>;
type DraftChange = Parameters<RecurrenceWorkspace['changeCreateDraft']>[1];
interface WorkspaceView {
  readonly result: { readonly current: RecurrenceWorkspace };
}

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function providers() {
  const client = createQueryClient({ retry: false });
  clients.push(client);
  return function Providers({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderWorkspace() {
  return renderHook(() => useRecurrenceWorkspace(anna.id, alpha.id, PROJECT_ID), { wrapper: providers() });
}

/** Each queued route answers its outcomes in order; an unplanned extra request gets a 500 and shows in the call log. */
function server(queues: Record<string, Answer[]>, reads: RouteTable = {}) {
  const table: RouteTable = { ...reads };
  for (const [route, answers] of Object.entries(queues)) {
    table[route] = () => answers.shift()?.() ?? failure(500, 'UNPLANNED_REQUEST', 'No answer queued');
  }
  const { calls } = installFakeApi(table);
  const previews = () => calls.filter((call) => call.path === createPreviewPath);
  /** Everything except reads and keyless previews. */
  const writes = () => calls.filter((call) => call.method !== 'GET' && call.path !== createPreviewPath);
  return { calls, previews, writes };
}

/** A response that never arrives: the request was sent, then the connection dropped. */
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

function currentSession(view: WorkspaceView): RecurrenceCreateSession {
  const session = view.result.current.createSession;
  if (session === null) throw new Error('Expected a retained create session.');
  return session;
}

function buildCurrent(view: WorkspaceView): RecurrenceCreatePreviewInput {
  const session = currentSession(view);
  const built = buildRecurrenceCreatePreviewInput(session.rule, session.template);
  if (!built.ok) throw new Error(`Draft does not build: ${built.problems.join(' ')}`);
  return built.input;
}

function filledRule(rule: RecurrenceRuleDraft): RecurrenceRuleDraft {
  return { ...rule, weekdays: [3, 1], startDate: '2026-10-19', count: '4', targetPeriodIds: [PERIOD_A] };
}

function filledTemplate(template: RecurrenceTemplateDraft): RecurrenceTemplateDraft {
  return { ...template, title: 'Синхронизация серии', attendeeMembershipIds: [...ATTENDEE_IDS] };
}

/** Opens the create form and types a complete draft, as the dialog's fields would. */
function openFilled(view: WorkspaceView): string {
  act(() => view.result.current.openCreate(createDefaults));
  const opened = currentSession(view);
  act(() => view.result.current.changeCreateDraft(opened.id, { rule: filledRule(opened.rule), template: filledTemplate(opened.template) }));
  return opened.id;
}

/** A checked draft and the create input the dialog would submit from its exact preview. */
async function previewedDraft(view: WorkspaceView): Promise<{ sessionId: string; input: CreateRecurrenceSeriesInput }> {
  const sessionId = openFilled(view);
  const previewInput = buildCurrent(view);
  act(() => view.result.current.checkCreateSchedule(sessionId, previewInput));
  await waitFor(() => expect(currentSession(view).previewInput).toEqual(previewInput));
  const preview = currentSession(view).preview;
  if (preview === null) throw new Error('Expected a preview for the checked draft.');
  return { sessionId, input: { ...previewInput, previewHash: preview.previewHash } };
}

function expectSameCreateCommand(writes: FakeRequest[], input: CreateRecurrenceSeriesInput): void {
  expect(writes).toHaveLength(2);
  const key = writes[0]?.headers.get('Idempotency-Key') ?? '';
  expect(isUuid(key)).toBe(true);
  for (const write of writes) {
    expect(write.method).toBe('POST');
    expect(write.path).toBe(seriesListPath);
    expect(write.headers.get('Idempotency-Key')).toBe(key);
    expect(write.body).toEqual(createRecurrenceSeriesInputSchema.parse(input));
    expect(write.body).not.toHaveProperty('draftId');
  }
}

describe('recurrence create draft', () => {
  it('is not dirty when merely opened, keeps periods and attendees explicit, and checking it sends no command', async () => {
    const answer = deferred<Response>();
    const { previews, writes } = server({ [`POST ${createPreviewPath}`]: [() => answer.promise] });
    const view = renderWorkspace();

    act(() => view.result.current.openCreate(createDefaults));
    const opened = currentSession(view);
    expect(view.result.current.createOpen).toBe(true);
    expect(view.result.current.createDirty).toBe(false);
    expect(opened.rule.startDate).toBe('');
    expect(opened.rule.targetPeriodIds).toEqual([]);
    expect(opened.template.attendeeMembershipIds).toEqual([]);
    expect(buildRecurrenceCreatePreviewInput(opened.rule, opened.template).ok).toBe(false);

    act(() => view.result.current.changeCreateDraft(opened.id, { template: { ...opened.template, title: 'Планёрка' } }));
    expect(view.result.current.createDirty).toBe(true);
    act(() => view.result.current.setCreateOpen(false));
    act(() => view.result.current.openCreate(createDefaults));
    expect(currentSession(view).id).toBe(opened.id);
    expect(currentSession(view).template.title).toBe('Планёрка');

    act(() => view.result.current.changeCreateDraft(opened.id, { rule: filledRule(opened.rule), template: filledTemplate(opened.template) }));
    const input = buildCurrent(view);
    expect(input).toEqual(createPreviewInput([PERIOD_A]));
    expect(input.template.attendeeMembershipIds).toEqual(ATTENDEE_IDS);

    act(() => view.result.current.checkCreateSchedule(opened.id, input));
    await act(async () => {
      answer.resolve(ok(createPreview(HASH_A)));
    });
    await waitFor(() => expect(currentSession(view).previewInput).toEqual(input));
    expect(currentSession(view).preview).toEqual(createPreview(HASH_A));

    expect(previews()).toHaveLength(1);
    expect(previews()[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(previews()[0]?.body).toEqual(input);
    await settle();
    expect(writes()).toEqual([]);
    expect(view.result.current.commands.create.pendingCommand).toBeNull();
    expect(view.result.current.lastCreatedSeries).toBeNull();
  });

  const edits: [string, (session: RecurrenceCreateSession) => DraftChange][] = [
    ['a raw title edit', (session) => ({ template: { ...session.template, title: 'Синхронизация серии (перенос)' } })],
    ['a raw duration edit', (session) => ({ rule: { ...session.rule, durationMinutes: '45' } })],
    ['a changed period choice', (session) => ({ rule: { ...session.rule, targetPeriodIds: [PERIOD_A, PERIOD_B] } })],
  ];
  it.each(edits)('drops a preview answered after %s; only a fresh check of the changed draft is kept', async (_label, edit) => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    const { previews, writes } = server({ [`POST ${createPreviewPath}`]: [() => stale.promise, () => fresh.promise] });
    const view = renderWorkspace();
    const sessionId = openFilled(view);
    const inputA = buildCurrent(view);

    act(() => view.result.current.checkCreateSchedule(sessionId, inputA));
    act(() => view.result.current.changeCreateDraft(sessionId, edit(currentSession(view))));
    await act(async () => {
      stale.resolve(ok(createPreview(HASH_A)));
    });
    await settle();
    expect(currentSession(view).preview).toBeNull();
    expect(currentSession(view).previewInput).toBeNull();

    const inputB = buildCurrent(view);
    expect(canonicalJson(inputB)).not.toBe(canonicalJson(inputA));
    act(() => view.result.current.checkCreateSchedule(sessionId, inputB));
    await act(async () => {
      fresh.resolve(ok(createPreview(HASH_B)));
    });
    await waitFor(() => expect(currentSession(view).previewInput).toEqual(inputB));
    expect(currentSession(view).preview?.previewHash).toBe(HASH_B);

    expect(previews().map((call) => call.body)).toEqual([inputA, inputB]);
    expect(previews().map((call) => call.headers.get('Idempotency-Key'))).toEqual([null, null]);
    expect(writes()).toEqual([]);
  });

  it('never lets a late answer for an older check replace the preview of the current draft', async () => {
    const older = deferred<Response>();
    const newer = deferred<Response>();
    server({ [`POST ${createPreviewPath}`]: [() => older.promise, () => newer.promise] });
    const view = renderWorkspace();
    const sessionId = openFilled(view);
    const inputA = buildCurrent(view);

    act(() => view.result.current.checkCreateSchedule(sessionId, inputA));
    act(() => view.result.current.changeCreateDraft(sessionId, { rule: { ...currentSession(view).rule, targetPeriodIds: [PERIOD_B] } }));
    const inputB = buildCurrent(view);
    act(() => view.result.current.checkCreateSchedule(sessionId, inputB));
    await act(async () => {
      newer.resolve(ok(createPreview(HASH_B, PERIOD_B)));
    });
    await waitFor(() => expect(currentSession(view).previewInput).toEqual(inputB));

    await act(async () => {
      older.resolve(ok(createPreview(HASH_A)));
    });
    await settle();
    expect(currentSession(view).previewInput).toEqual(inputB);
    expect(currentSession(view).preview).toEqual(createPreview(HASH_B, PERIOD_B));
  });
});

describe('recurrence create retry', () => {
  it('retires the submitted draft when its lost create is retried from the hook with the dialog still showing it', async () => {
    const gate = deferred<undefined>();
    const confirmed = series();
    const { writes } = server({
      [`POST ${createPreviewPath}`]: [() => ok(createPreview(HASH_A))],
      [`POST ${seriesListPath}`]: [lostAfter(gate), () => created(confirmed)],
    });
    const view = renderWorkspace();
    const { sessionId, input } = await previewedDraft(view);
    const variables: CreateSeriesVariables = { draftId: sessionId, input };

    act(() => view.result.current.commands.create.mutate(variables));
    await act(async () => {
      gate.resolve(undefined);
    });
    await waitFor(() => expect(view.result.current.commands.create.uncertain?.variables).toEqual(variables));
    expect(currentSession(view).id).toBe(sessionId);
    expect(view.result.current.createOpen).toBe(true);

    act(() => view.result.current.commands.create.retryUncertain());
    await waitFor(() => expect(view.result.current.lastCreatedSeries).toEqual(confirmed));
    expect(view.result.current.createSession).toBeNull();
    expect(view.result.current.createOpen).toBe(false);
    expect(view.result.current.createDirty).toBe(false);
    expectSameCreateCommand(writes(), input);
  });

  it('retires only the submitted draft A when its lost create is confirmed after the page retained draft B', async () => {
    const gate = deferred<undefined>();
    const confirmed = series();
    const { writes } = server({
      [`POST ${createPreviewPath}`]: [() => ok(createPreview(HASH_A))],
      [`POST ${seriesListPath}`]: [lostAfter(gate), () => created(confirmed)],
    });
    const view = renderWorkspace();
    const { sessionId, input } = await previewedDraft(view);
    const variables: CreateSeriesVariables = { draftId: sessionId, input };

    act(() => view.result.current.commands.create.mutate(variables));
    await act(async () => {
      gate.resolve(undefined);
    });
    await waitFor(() => expect(view.result.current.commands.create.uncertain?.variables).toEqual(variables));
    // A lost answer is not a confirmation: draft A is still retained.
    expect(currentSession(view).id).toBe(sessionId);
    expect(view.result.current.lastCreatedSeries).toBeNull();

    // A's dialog is gone; the page now retains and shows a different, typed draft B.
    const fresh = newRecurrenceCreateSession(createDefaults);
    const draftB: RecurrenceCreateSession = { ...fresh, template: { ...fresh.template, title: 'Другая серия' } };
    act(() => view.result.current.setCreateOpen(false));
    act(() => view.result.current.setCreateSession(draftB));
    act(() => view.result.current.setCreateOpen(true));

    // Explicit retry through the page-owned hook; no dialog callback is attached.
    act(() => view.result.current.commands.create.retryUncertain());
    await waitFor(() => expect(view.result.current.lastCreatedSeries).toEqual(confirmed));

    expect(view.result.current.commands.create.uncertain).toBeNull();
    expect(view.result.current.createSession).toEqual(draftB);
    expect(view.result.current.createOpen).toBe(true);
    expect(view.result.current.createDirty).toBe(true);
    expectSameCreateCommand(writes(), input);
    await settle();
    expect(writes()).toHaveLength(2);
  });
});

describe('recurrence materialization chunks', () => {
  function renderWithSelectedPeriod(periodId: string) {
    return renderHook(
      ({ selectedPeriodId }: { selectedPeriodId: string }) => ({
        workspace: useRecurrenceWorkspace(anna.id, alpha.id, PROJECT_ID),
        readiness: useRecurrenceReadinessQuery(anna.id, alpha.id, selectedPeriodId),
      }),
      { wrapper: providers(), initialProps: { selectedPeriodId: periodId } },
    );
  }

  it('stores a retried lost chunk only under its original period, keeps its cursor and sends no next chunk', async () => {
    const gate = deferred<undefined>();
    const resultB = materialization(PERIOD_B, { createdCount: 2, remainingCount: 0, nextCursor: null });
    const resultA = materialization(PERIOD_A, { createdCount: 1, remainingCount: 1, nextCursor: 'signed.chunk-2.token' });
    const { writes } = server(
      {
        [`POST ${materializePath(PERIOD_B)}`]: [() => ok(resultB)],
        [`POST ${materializePath(PERIOD_A)}`]: [lostAfter(gate), () => ok(resultA)],
      },
      {
        [`GET ${readinessPath(PERIOD_A)}`]: () => ok(readiness(PERIOD_A)),
        [`GET ${readinessPath(PERIOD_B)}`]: () => ok(readiness(PERIOD_B)),
      },
    );
    const view = renderWithSelectedPeriod(PERIOD_B);

    // Rendering, reading readiness and opening a form write nothing.
    act(() => view.result.current.workspace.openCreate(createDefaults));
    await waitFor(() => expect(view.result.current.readiness.data).toEqual(readiness(PERIOD_B)));
    await settle();
    expect(writes()).toEqual([]);

    const chunkB: MaterializePeriodVariables = { periodId: PERIOD_B, input: { limit: 25 } };
    act(() => view.result.current.workspace.commands.materialize.mutate(chunkB));
    await waitFor(() => expect(view.result.current.workspace.materializationByPeriod[PERIOD_B]).toEqual(resultB));

    view.rerender({ selectedPeriodId: PERIOD_A });
    await waitFor(() => expect(view.result.current.readiness.data).toEqual(readiness(PERIOD_A)));
    const chunkA: MaterializePeriodVariables = { periodId: PERIOD_A, input: { limit: 25 } };
    act(() => view.result.current.workspace.commands.materialize.mutate(chunkA));
    await act(async () => {
      gate.resolve(undefined);
    });
    await waitFor(() => expect(view.result.current.workspace.commands.materialize.uncertain?.variables).toEqual(chunkA));
    expect(view.result.current.workspace.materializationByPeriod).toEqual({ [PERIOD_B]: resultB });

    // Period B is selected again and read before the explicit retry; no local onSuccess is passed.
    view.rerender({ selectedPeriodId: PERIOD_B });
    await waitFor(() => expect(view.result.current.readiness.data).toEqual(readiness(PERIOD_B)));
    act(() => view.result.current.workspace.commands.materialize.retryUncertain());
    await waitFor(() => expect(view.result.current.workspace.materializationByPeriod[PERIOD_A]).toEqual(resultA));

    expect(view.result.current.workspace.materializationByPeriod).toEqual({ [PERIOD_A]: resultA, [PERIOD_B]: resultB });
    expect(view.result.current.workspace.materializationByPeriod[PERIOD_A]?.nextCursor).toBe('signed.chunk-2.token');
    expect(view.result.current.workspace.commands.materialize.uncertain).toBeNull();

    await settle();
    const sent = writes();
    expect(sent.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', materializePath(PERIOD_B), { limit: 25 }],
      ['POST', materializePath(PERIOD_A), { limit: 25 }],
      ['POST', materializePath(PERIOD_A), { limit: 25 }],
    ]);
    const keys = sent.map((call) => call.headers.get('Idempotency-Key') ?? '');
    expect(keys.every(isUuid)).toBe(true);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
