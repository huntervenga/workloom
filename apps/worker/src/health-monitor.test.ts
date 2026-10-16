import { describe, expect, it } from 'vitest';
import { createHealthMonitor, type HealthSchedule } from './health-monitor.js';
import type { WorkerHealthReport } from './health.js';
import { createWorkerLogger } from './logging.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((done) => setImmediate(done));
function report(): WorkerHealthReport {
  return {
    status: 'degraded', reasons: ['relay_unsupported_events'], checkedAt: '2026-10-16T03:00:00.000Z', lifecycle: 'running',
    heartbeat: { lastRelayCycleAt: null, ageMs: 12, stale: false }, queues: [], reportedDeadLetterCount: null,
    queueErrorsSinceStart: 0,
    relay: { state: 'ok', pendingSubscribedCount: 3, oldestSubscribedAt: null, oldestSubscribedAgeMs: null, unsupportedSubscribedCount: 1, consecutiveFailures: 0, failedBatches: 0 },
    jobs: { outcomes: { complete: 0, pending: 0, stale: 0, paused: 0, blocked: 0 }, rejected: 0, failed: 0 },
  };
}
function scheduler() {
  const pending: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: HealthSchedule = (run, ms) => {
    const timer = { run, ms, cancelled: false }; pending.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { schedule, pending };
}

describe('operational health observation', () => {
  it('reads immediately, schedules only after settlement and cancels the next timer', async () => {
    const first = deferred<WorkerHealthReport>();
    const clock = scheduler();
    const lines: string[] = [];
    let reads = 0;
    const monitor = createHealthMonitor({
      read: () => { reads += 1; return reads === 1 ? first.promise : Promise.resolve(report()); },
      logger: createWorkerLogger({ level: 'trace', sink: line => lines.push(line) }), schedule: clock.schedule,
    });
    monitor.start(); monitor.start();
    expect(reads).toBe(1);
    expect(clock.pending).toHaveLength(0);
    first.resolve(report()); await flush();
    expect(clock.pending).toHaveLength(1);
    expect(clock.pending[0]?.ms).toBe(30_000);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'worker.health', status: 'degraded', pendingCount: 3, unsupportedCount: 1 });
    clock.pending[0]?.run(); await flush();
    expect(reads).toBe(2);
    expect(clock.pending).toHaveLength(2);
    monitor.stop();
    expect(clock.pending[1]?.cancelled).toBe(true);
    clock.pending[1]?.run();
    await monitor.drain();
    expect(reads).toBe(2);
  });

  it('shutdown drains the actual in-flight promise and starts no later observation', async () => {
    const reading = deferred<WorkerHealthReport>();
    const clock = scheduler();
    const monitor = createHealthMonitor({ read: () => reading.promise, logger: createWorkerLogger({ level: 'silent' }), schedule: clock.schedule });
    monitor.start(); monitor.stop();
    let drained = false;
    const drain = monitor.drain().then(() => { drained = true; });
    await flush(); expect(drained).toBe(false);
    reading.resolve(report()); await drain;
    expect(drained).toBe(true); expect(clock.pending).toHaveLength(0);
  });

  it('logs safe failures and resumes observations after a read rejection', async () => {
    const lines: string[] = []; const clock = scheduler();
    const monitor = createHealthMonitor({
      read: () => Promise.reject(new Error('postgres://private:secret@127.0.0.1/private')),
      logger: createWorkerLogger({ level: 'trace', sink: line => lines.push(line) }), schedule: clock.schedule,
    });
    monitor.start(); await flush();
    expect(lines.join('\n')).not.toContain('secret');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'worker.health_failed', error: { name: 'Error' } });
    expect(clock.pending).toHaveLength(1);
    monitor.stop(); await monitor.drain();
  });
});
