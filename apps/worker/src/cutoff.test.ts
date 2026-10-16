import type { CutoffJob, CutoffRequestedEvent, CutoffWorkerOutcome } from '@workloom/contracts';
import { CUTOFF_QUEUE, CUTOFF_QUEUE_OPTIONS } from '@workloom/db';
import type { DrizzleTransactionLike } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { CutoffEventRejectedError, CutoffJobFailedError, InvalidCutoffJobError, InvalidCutoffOutcomeError, createCutoffEnqueue, createCutoffHandler } from './cutoff.js';
import { createWorkerLogger } from './logging.js';
import type { QueueSendOptions } from './queue.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const job: CutoffJob = { schemaVersion: 1, requestId: id('1'), workspaceId: id('2'), projectId: id('3'), periodId: id('4'), grantId: id('5'), grantRevision: 1, periodRevision: 2, cutoffAt: '2026-10-25T01:30:00.000Z', sourceManifestHash: 'a'.repeat(64) };
const { workspaceId, schemaVersion, ...payload } = job;
const event: CutoffRequestedEvent = { eventId: id('6'), workspaceId, schemaVersion, type: 'planning.cutoff_requested', payload, occurredAt: '2026-10-16T09:00:00.000Z' };
const outcome = (status: CutoffWorkerOutcome['status']): CutoffWorkerOutcome => ({ schemaVersion: 1, requestId: job.requestId, periodId: job.periodId, status, processedAt: event.occurredAt, createdCount: 0, remainingCount: 0, baselineId: null, frozenAt: null, nextRequestId: null, blockedCode: null });
const logger = createWorkerLogger({ level: 'silent' });

describe('cutoff enqueue', () => {
  it('uses the stored absolute UTC instant, exact request ID, queue retry settings and the supplied relay transaction', async () => {
    const execute = vi.fn(async () => [{ id: event.eventId }]);
    const tx: DrizzleTransactionLike = { execute };
    const sends: { name: string; data: object; options: QueueSendOptions }[] = [];
    const enqueue = createCutoffEnqueue({ send: async (name, data, options) => { sends.push({ name, data, options }); return null; } });
    await expect(enqueue(tx, event)).resolves.toEqual({ accepted: true, jobId: null });
    const sent = required(sends[0]);
    expect(sent.name).toBe(CUTOFF_QUEUE);
    expect(sent.data).toEqual(job);
    expect(sent.options).toMatchObject({ id: event.eventId, startAfter: job.cutoffAt, group: { id: job.workspaceId }, retryLimit: CUTOFF_QUEUE_OPTIONS.retryLimit });
    expect(Object.keys(sent.options).sort()).toEqual(['db', 'group', 'id', 'retryBackoff', 'retryDelay', 'retryDelayMax', 'retryLimit', 'startAfter']);
    expect(execute).not.toHaveBeenCalled();
    await expect(sent.options.db.executeSql('select $1::uuid', [event.eventId])).resolves.toEqual({ rows: [{ id: event.eventId }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects versions, foreign events and actor payloads without sending; propagates queue insert failure', async () => {
    const send = vi.fn(async () => null);
    const enqueue = createCutoffEnqueue({ send });
    const tx: DrizzleTransactionLike = { execute: async () => [] };
    for (const invalid of [{ ...event, schemaVersion: 2 }, { ...event, type: 'unrelated' }, { ...event, payload: { ...payload, actorUserId: id('7') } }]) {
      await expect(enqueue(tx, invalid as CutoffRequestedEvent)).rejects.toBeInstanceOf(CutoffEventRejectedError);
    }
    expect(send).not.toHaveBeenCalled();
    const failure = new Error('Queue insertion failed');
    await expect(createCutoffEnqueue({ send: async () => { throw failure; } })(tx, event)).rejects.toBe(failure);
  });
});

describe('cutoff handler', () => {
  it.each(['frozen', 'already_frozen', 'pending', 'not_due', 'stale', 'blocked'] as const)('acknowledges %s with a single facade call', async status => {
    const freezeDuePeriod = vi.fn(async () => outcome(status));
    const handler = createCutoffHandler({ facade: { freezeDuePeriod }, logger });
    await expect(handler.handle([{ id: event.eventId, data: job, retryCount: 0 }])).resolves.toEqual(outcome(status));
    expect(freezeDuePeriod).toHaveBeenCalledExactlyOnceWith(job);
    expect(handler.counters().outcomes[status]).toBe(1);
    expect(handler.counters().failed).toBe(0);
  });

  it('rejects actor injection and oversized batches before any facade call', async () => {
    const freezeDuePeriod = vi.fn(async () => outcome('frozen'));
    const handler = createCutoffHandler({ facade: { freezeDuePeriod }, logger });
    const queued = { id: event.eventId, data: { ...job, actorUserId: id('7') }, retryCount: 0 };
    for (const batch of [[], [queued], [queued, queued]]) await expect(handler.handle(batch)).rejects.toBeInstanceOf(InvalidCutoffJobError);
    expect(freezeDuePeriod).not.toHaveBeenCalled();
    expect(handler.counters().rejected).toBe(3);
  });

  it('stores only a safe classification on unexpected failure and validates outcome target identity', async () => {
    const privateText = 'private task title postgres://secret@localhost';
    const failure = Object.assign(new Error(privateText), { code: '40001' });
    const handler = createCutoffHandler({ facade: { freezeDuePeriod: async () => { throw failure; } }, logger });
    const thrown = await handler.handle([{ id: event.eventId, data: job, retryCount: 2 }]).catch(error => error as Error);
    expect(thrown).toBeInstanceOf(CutoffJobFailedError);
    expect(String(thrown)).not.toContain(privateText);
    expect(thrown).toMatchObject({ code: '40001' });
    const invalid = createCutoffHandler({ facade: { freezeDuePeriod: async () => ({ ...outcome('pending'), requestId: id('9') }) }, logger });
    await expect(invalid.handle([{ id: event.eventId, data: job, retryCount: 0 }])).rejects.toBeInstanceOf(InvalidCutoffOutcomeError);
    expect(invalid.counters().failed).toBe(1);
  });
});

function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error('Expected test fixture value.'); return value; }
