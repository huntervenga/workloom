import type { CutoffDiscovery, CutoffDiscoveryBatchResult } from '@workloom/domain';
import type { WorkerLogger } from './logging.js';
import { createBatchPoller, type RelaySchedule } from './relay.js';

/** One bounded durable discovery batch per poll, with the same non-overlap/backoff/drain guarantees as relay. */
export function createCutoffDiscoveryPoller(options: {
  readonly discovery: CutoffDiscovery; readonly intervalMs: number; readonly logger: WorkerLogger;
  readonly batchLimit?: number; readonly schedule?: RelaySchedule; readonly now?: () => number;
}) {
  let lastBatch: CutoffDiscoveryBatchResult | null = null;
  const poller = createBatchPoller({
    async batch(limit) {
        lastBatch = await options.discovery.discoverBatch(limit);
        if (lastBatch.blockedCount > 0) options.logger.warn('cutoff.discovery_blocked', { count: lastBatch.blockedCount });
        return { selectedCount: lastBatch.selectedCount, enqueuedCount: lastBatch.requestedCount, unsupportedRetainedCount: 0 };
    },
    intervalMs: options.intervalMs, logger: options.logger,
    ...(options.batchLimit === undefined ? {} : { batchLimit: options.batchLimit }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { ...poller, snapshot: () => ({ ...poller.snapshot(), discoveryBatch: lastBatch }) };
}
