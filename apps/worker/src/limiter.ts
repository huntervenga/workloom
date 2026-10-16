import type { QueueJobHandler } from './queue.js';

/** FIFO admission shared by both consumers. Queue prefetch is bounded by their localConcurrency. */
export function createJobLimiter(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Job concurrency must be a positive integer.');
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    wrap(handler: QueueJobHandler): QueueJobHandler {
      return async (jobs) => {
        await new Promise<void>((resolve) => {
          if (active < concurrency) { active += 1; resolve(); }
          else waiting.push(resolve);
        });
        try { return await handler(jobs); }
        finally {
          const next = waiting.shift();
          if (next === undefined) active -= 1;
          else next();
        }
      };
    },
    snapshot() { return { active, waiting: waiting.length, concurrency }; },
  };
}
