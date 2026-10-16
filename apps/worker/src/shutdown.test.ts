import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createWorkerLogger } from './logging.js';
import { bindShutdownSignals, createShutdown, type ShutdownStep } from './shutdown.js';

const SECRET_MESSAGE = 'canary: close failed for postgres://workloom:canary-pw@127.0.0.1/workloom';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

function recorder() {
  const calls: string[] = [];
  const step = (name: string, run?: () => void | Promise<void>): ShutdownStep => ({
    name,
    run: async () => {
      calls.push(`${name}:start`);
      await run?.();
      calls.push(`${name}:end`);
    },
  });
  return { calls, step };
}

describe('createShutdown', () => {
  it('stops intake, waits for the drain, then closes resources in declared order', async () => {
    const { calls, step } = recorder();
    const inFlight = deferred();
    const controller = createShutdown({
      stopIntake: [step('queue.stop_fetching')],
      drain: [step('queue.drain', () => inFlight.promise)],
      close: [step('queue.close'), step('db.close')],
    });

    const result = controller.shutdown('SIGTERM');
    await flush();
    expect(calls).toEqual(['queue.stop_fetching:start', 'queue.stop_fetching:end', 'queue.drain:start']);

    inFlight.resolve();
    await expect(result).resolves.toEqual({ status: 'clean', reason: 'SIGTERM', failures: [], skipped: [] });
    expect(calls).toEqual([
      'queue.stop_fetching:start',
      'queue.stop_fetching:end',
      'queue.drain:start',
      'queue.drain:end',
      'queue.close:start',
      'queue.close:end',
      'db.close:start',
      'db.close:end',
    ]);
  });

  it('runs once for concurrent and later calls and keeps the first reason', async () => {
    const close = vi.fn();
    const controller = createShutdown({ close: [{ name: 'db.close', run: close }] });
    expect(controller.started).toBe(false);

    const first = controller.shutdown('SIGTERM');
    const second = controller.shutdown('SIGINT');
    expect(second).toBe(first);
    expect(controller.started).toBe(true);
    await first;
    const third = controller.shutdown('manual');

    expect(third).toBe(first);
    expect((await third).reason).toBe('SIGTERM');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('skips the drain but still closes every resource when intake cannot be stopped', async () => {
    const { calls, step } = recorder();
    const controller = createShutdown({
      stopIntake: [
        step('queue.stop_fetching', () => {
          throw Object.assign(new Error(SECRET_MESSAGE), { code: 'ECONNRESET' });
        }),
      ],
      drain: [step('queue.drain')],
      close: [
        step('queue.close', () => Promise.reject(new TypeError(SECRET_MESSAGE))),
        step('db.close'),
      ],
    });

    const result = await controller.shutdown('SIGTERM');

    expect(calls).toEqual(['queue.stop_fetching:start', 'queue.close:start', 'db.close:start', 'db.close:end']);
    expect(result).toEqual({
      status: 'failed',
      reason: 'SIGTERM',
      failures: [
        { phase: 'stopIntake', step: 'queue.stop_fetching', error: { name: 'Error', code: 'ECONNRESET' } },
        { phase: 'close', step: 'queue.close', error: { name: 'TypeError' } },
      ],
      skipped: [{ phase: 'drain', step: 'queue.drain' }],
    });
    expect(JSON.stringify(result)).not.toContain('canary');
  });

  it('closes resources after a drain failure, including a synchronous throw', async () => {
    const { calls, step } = recorder();
    const controller = createShutdown({
      drain: [
        {
          name: 'queue.drain',
          run: () => {
            throw new RangeError(SECRET_MESSAGE);
          },
        },
      ],
      close: [step('db.close')],
    });

    const result = await controller.shutdown('SIGINT');

    expect(calls).toEqual(['db.close:start', 'db.close:end']);
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([{ phase: 'drain', step: 'queue.drain', error: { name: 'RangeError' } }]);
    expect(result.skipped).toEqual([]);
  });

  it('logs safe progress and failures without error messages (canary)', async () => {
    const lines: string[] = [];
    const logger = createWorkerLogger({ level: 'trace', sink: (line) => lines.push(line) });
    const controller = createShutdown(
      { close: [{ name: 'db.close', run: () => Promise.reject(new Error(SECRET_MESSAGE)) }] },
      { logger },
    );

    await controller.shutdown('SIGTERM');

    const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(['worker.shutdown_started', 'worker.shutdown_step_failed', 'worker.shutdown_finished']);
    expect(lines.join('\n')).not.toContain('canary');
  });

  it('never rejects, even when an injected logger throws', async () => {
    const logger = {
      ...createWorkerLogger({ level: 'silent' }),
      log: () => {
        throw new Error('logger down');
      },
    };
    const close = vi.fn();
    const controller = createShutdown({ close: [{ name: 'db.close', run: close }] }, { logger });

    await expect(controller.shutdown('SIGTERM')).resolves.toMatchObject({ status: 'clean' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('bindShutdownSignals', () => {
  it('runs shutdown once for duplicate SIGTERM/SIGINT and reports the result once', async () => {
    const source = new EventEmitter();
    const close = vi.fn();
    const onSettled = vi.fn();
    const controller = createShutdown({ close: [{ name: 'db.close', run: close }] });
    const dispose = bindShutdownSignals(controller, { source, onSettled });

    source.emit('SIGTERM');
    source.emit('SIGINT');
    source.emit('SIGTERM');
    await flush();

    expect(close).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'clean', reason: 'SIGTERM' }));
    dispose();
  });

  it('removes exactly its listeners on dispose and tolerates repeated dispose', () => {
    const source = new EventEmitter();
    const unrelated = vi.fn();
    source.on('SIGTERM', unrelated);
    const controller = createShutdown({});
    const dispose = bindShutdownSignals(controller, { source });
    expect(source.listenerCount('SIGTERM')).toBe(2);
    expect(source.listenerCount('SIGINT')).toBe(1);

    dispose();
    dispose();
    source.emit('SIGINT');

    expect(source.listenerCount('SIGTERM')).toBe(1);
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(controller.started).toBe(false);
  });

  it('binds only the requested signals and isolates a throwing onSettled callback', async () => {
    const source = new EventEmitter();
    const controller = createShutdown({});
    const dispose = bindShutdownSignals(controller, {
      source,
      signals: ['SIGTERM'],
      onSettled: () => {
        throw new Error('callback failed');
      },
    });
    expect(source.listenerCount('SIGINT')).toBe(0);

    source.emit('SIGTERM');
    await flush();

    expect(controller.started).toBe(true);
    dispose();
  });
});
