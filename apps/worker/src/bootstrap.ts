import {
  WORKLOOM_QUEUE_SCHEMA,
  createDatabase,
  createReadinessProbe,
  createRecurrenceOutboxRelay,
  createRecurrenceWorkerFacade,
  type WorkloomExecutor,
} from '@workloom/db';
import type { RecurrenceOutboxRelay, RecurrenceWorkerFacade } from '@workloom/domain';

import type { WorkerConfig } from './config.js';
import type { WorkerLogger } from './logging.js';
import { createPgBossQueueClient } from './queue.js';
import { createWorkerRuntime, type WorkerRuntime } from './runtime.js';

export const WORKER_DB_APPLICATION_NAME = 'workloom-worker';

/**
 * Builds the real worker from validated local configuration: one application
 * pool (bounded by WORKER_DB_POOL_MAX) for the domain facade and relay, and one
 * pg-boss pool (bounded by WORKER_QUEUE_POOL_MAX) on the pre-migrated
 * `workloom_queue` schema. Both are owned and closed by the runtime's
 * shutdown. No connection is opened here; `runtime.start()` connects, and its
 * first step is the shared application readiness probe on the same pool.
 */
export async function createWorkerFromConfig(config: WorkerConfig, logger: WorkerLogger): Promise<WorkerRuntime> {
  const database = createDatabase(config.database.url, {
    maxConnections: config.appPoolMax,
    requireLoopback: true,
    applicationName: WORKER_DB_APPLICATION_NAME,
  });
  try {
    const facade: RecurrenceWorkerFacade = createRecurrenceWorkerFacade(database);
    const relay: RecurrenceOutboxRelay<WorkloomExecutor> = createRecurrenceOutboxRelay(database);
    const queue = createPgBossQueueClient(config, { schema: WORKLOOM_QUEUE_SCHEMA });
    return createWorkerRuntime<WorkloomExecutor>({
      config,
      logger,
      readiness: createReadinessProbe(database),
      queue,
      facade,
      relay,
      ownedResources: [{ name: 'database.close', close: () => database.close() }],
    });
  } catch (error) {
    // The pool connects lazily, but it is still ours: end it before reporting the failure.
    await database.close().catch(() => undefined);
    throw error;
  }
}
