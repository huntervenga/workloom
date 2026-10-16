import type { CutoffDiscoveryBatchResult } from '@workloom/domain';
import { describe, expect, it } from 'vitest';
import { createCutoffDiscoveryPoller } from './discovery.js';
import { createWorkerLogger } from './logging.js';

const flush = () => new Promise<void>(done => setImmediate(done));
const result: CutoffDiscoveryBatchResult = { selectedCount: 50, requestedCount: 40, blockedCount: 10, cycleComplete: false, leased: true };

describe('bounded cutoff discovery lifecycle', () => {
  it('runs one batch without overlap, waits between batches and drains the final durable checkpoint', async () => {
    const pending: ((result: CutoffDiscoveryBatchResult) => void)[] = [];
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const limits: (number | undefined)[] = [];
    const poller = createCutoffDiscoveryPoller({
      discovery: { discoverBatch: (limit) => { limits.push(limit); return new Promise(resolve => pending.push(resolve)); } },
      intervalMs: 2000, logger: createWorkerLogger({ level: 'silent' }),
      schedule: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    });
    poller.start(); poller.start();
    expect(limits).toEqual([50]);
    expect(timers).toHaveLength(0);
    required(pending.shift())(result); await flush();
    expect(poller.snapshot().discoveryBatch).toEqual(result);
    expect(timers[0]?.ms).toBe(2000);
    required(timers[0]).run();
    expect(limits).toEqual([50, 50]);
    poller.stop();
    let drained = false;
    const draining = poller.drain().then(() => { drained = true; });
    await flush(); expect(drained).toBe(false);
    required(pending.shift())({ ...result, cycleComplete: true });
    await draining;
    expect(timers).toHaveLength(1);
    expect(poller.snapshot().running).toBe(false);
  });

  it('backs off discovery failures and reports safe failure metadata', async () => {
    const delays: number[] = [];
    const poller = createCutoffDiscoveryPoller({ discovery: { discoverBatch: async () => { throw new Error('private sentinel'); } }, intervalMs: 2000, logger: createWorkerLogger({ level: 'silent' }), schedule: (_run, ms) => { delays.push(ms); return () => undefined; } });
    poller.start(); await flush();
    expect(delays).toEqual([4000]);
    expect(poller.snapshot()).toMatchObject({ failedBatches: 1, consecutiveFailures: 1, lastError: { name: 'Error' } });
    expect(JSON.stringify(poller.snapshot())).not.toContain('private sentinel');
    poller.stop(); await poller.drain();
  });
});

function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error('Expected test fixture value.'); return value; }
