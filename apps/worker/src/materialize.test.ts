import type { RecurrenceMaterializationJob } from '@workloom/contracts';
import type { RecurrenceWorkerFacade, RecurrenceWorkerOutcome, RecurrenceWorkerStatus } from '@workloom/domain';
import { describe, expect, it } from 'vitest';

import { createWorkerLogger } from './logging.js';
import {
  InvalidMaterializationJobError,
  MaterializationJobFailedError,
  UnexpectedJobBatchError,
  createMaterializationHandler,
} from './materialize.js';
import type { QueueJob } from './queue.js';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const SERIES_ID = '00000000-0000-4000-8000-000000000002';
const BINDING_ID = '00000000-0000-4000-8000-000000000003';
const PERIOD_ID = '00000000-0000-4000-8000-000000000004';
const ACTOR_ID = '00000000-0000-4000-8000-000000000005';
const JOB_ID = '00000000-0000-4000-8000-0000000000e1';
const CANARY = 'canary-private-title postgres://workloom:canary-pw@127.0.0.1/workloom';

function jobData(): RecurrenceMaterializationJob {
  return {
    workspaceId: WORKSPACE_ID,
    seriesId: SERIES_ID,
    bindingId: BINDING_ID,
    sourceManifestHash: 'b'.repeat(64),
    authorizationRevision: 2,
    requestId: `outbox:${JOB_ID}`,
  };
}

function queueJob(data: unknown, retryCount = 0): QueueJob {
  return { id: JOB_ID, data, retryCount };
}

function outcome(status: RecurrenceWorkerStatus, overrides: Partial<RecurrenceWorkerOutcome> = {}): RecurrenceWorkerOutcome {
  return { status, bindingId: BINDING_ID, periodId: PERIOD_ID, createdCount: 3, remainingCount: 0, blockedCode: null, ...overrides };
}

function recordingFacade(result: (job: RecurrenceMaterializationJob) => Promise<RecurrenceWorkerOutcome>) {
  const calls: RecurrenceMaterializationJob[] = [];
  const facade: RecurrenceWorkerFacade = {
    materializeBinding(job) {
      calls.push(job);
      return result(job);
    },
  };
  return { facade, calls };
}

function capture() {
  const lines: string[] = [];
  return { lines, logger: createWorkerLogger({ level: 'trace', sink: (line) => lines.push(line) }) };
}

describe('createMaterializationHandler', () => {
  it.each([
    ['complete', outcome('complete')],
    ['pending', outcome('pending', { createdCount: 100, remainingCount: 40 })],
    ['stale', outcome('stale', { createdCount: 0 })],
    ['blocked', outcome('blocked', { createdCount: 0, remainingCount: 5, blockedCode: 'authorizer_capability_revoked' })],
    ['paused', outcome('paused', { createdCount: 0 })],
  ] as const)('acknowledges a controlled %s outcome after exactly one facade call, returning metadata only', async (status, result) => {
    const { facade, calls } = recordingFacade(async () => result);
    const handler = createMaterializationHandler({ facade, logger: createWorkerLogger({ level: 'silent' }) });

    await expect(handler.handle([queueJob(jobData())])).resolves.toStrictEqual({
      status,
      bindingId: BINDING_ID,
      periodId: PERIOD_ID,
      createdCount: result.createdCount,
      remainingCount: result.remainingCount,
      blockedCode: result.blockedCode,
    });
    expect(calls).toStrictEqual([jobData()]);
    expect(handler.counters()).toMatchObject({ failed: 0, rejected: 0, lastFailureAt: null });
    expect(handler.counters().outcomes[status]).toBe(1);
  });

  it('rejects job data carrying an actor or other extra keys without calling the facade', async () => {
    const { facade, calls } = recordingFacade(async () => outcome('complete'));
    const { lines, logger } = capture();
    const handler = createMaterializationHandler({ facade, logger });

    for (const data of [
      { ...jobData(), actorUserId: ACTOR_ID },
      { ...jobData(), now: '2026-10-16T00:00:00.000Z' },
      { ...jobData(), title: CANARY },
      { ...jobData(), authorizationRevision: '2' },
      null,
    ]) {
      await expect(handler.handle([queueJob(data)])).rejects.toBeInstanceOf(InvalidMaterializationJobError);
    }
    expect(calls).toHaveLength(0);
    expect(handler.counters().rejected).toBe(5);
    expect(lines.join('\n')).not.toContain('canary');
    expect(lines.join('\n')).not.toContain(ACTOR_ID);
  });

  it('turns an unexpected facade error into a safe rejection that reaches the queue retry path', async () => {
    const original = Object.assign(new Error(CANARY), { code: '40P01', detail: CANARY });
    const { facade, calls } = recordingFacade(() => Promise.reject(original));
    const { lines, logger } = capture();
    const handler = createMaterializationHandler({ facade, logger });

    const rejection = await handler.handle([queueJob(jobData(), 2)]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(MaterializationJobFailedError);
    expect(rejection).toMatchObject({ code: '40P01', causeName: 'Error' });
    // pg-boss stores the thrown error as job output: it must not carry the original text or cause.
    expect(JSON.stringify(rejection)).not.toContain('canary');
    expect(String(rejection)).not.toContain('canary');
    expect(rejection).not.toHaveProperty('cause');
    expect(calls).toHaveLength(1);
    expect(handler.counters()).toMatchObject({ failed: 1 });
    expect(lines.join('\n')).not.toContain('canary');
    expect(lines.some((line) => line.includes('"materialize.job_failed"') && line.includes('"attempt":2'))).toBe(true);
  });

  it('refuses any batch that is not exactly one job, executing nothing', async () => {
    const { facade, calls } = recordingFacade(async () => outcome('complete'));
    const handler = createMaterializationHandler({ facade, logger: createWorkerLogger({ level: 'silent' }) });

    await expect(handler.handle([])).rejects.toBeInstanceOf(UnexpectedJobBatchError);
    await expect(handler.handle([queueJob(jobData()), queueJob(jobData())])).rejects.toBeInstanceOf(UnexpectedJobBatchError);
    expect(calls).toHaveLength(0);
  });

  it('logs only IDs, status, counts and block codes', async () => {
    const { facade } = recordingFacade(async () => outcome('blocked', { createdCount: 0, blockedCode: 'authorizer_inactive' }));
    const { lines, logger } = capture();
    await createMaterializationHandler({ facade, logger }).handle([queueJob(jobData())]);

    const [line] = lines;
    expect(JSON.parse(line ?? '{}')).toMatchObject({
      level: 'warn',
      event: 'materialize.job_done',
      jobId: JOB_ID,
      workspaceId: WORKSPACE_ID,
      entityType: 'recurrence_binding',
      entityId: BINDING_ID,
      result: 'blocked',
      reason: 'authorizer_inactive',
      count: 0,
    });
    expect(line).not.toContain('b'.repeat(64));
    expect(line).not.toContain('outbox:');
  });
});
