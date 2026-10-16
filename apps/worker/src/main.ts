/**
 * Process entry point: load the optional repository .env (existing variables
 * win), validate the local-only configuration, bind SIGTERM/SIGINT before
 * anything connects, then start the runtime. A signal during startup aborts it
 * through the same shutdown. Never migrates the queue or the database schema.
 */
import { fileURLToPath } from 'node:url';

import { loadEnvFileIfPresent } from '@workloom/db';

import { createWorkerFromConfig } from './bootstrap.js';
import { WorkerConfigError, loadWorkerConfig, type WorkerConfig } from './config.js';
import { createWorkerLogger } from './logging.js';
import { WorkerStartAbortedError } from './runtime.js';
import { bindShutdownSignals, type ShutdownResult } from './shutdown.js';

async function main(): Promise<void> {
  loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));

  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(process.env);
  } catch (error) {
    if (error instanceof WorkerConfigError) {
      // Issues name variables and rules only; values are never echoed.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createWorkerLogger({ level: config.logLevel });
  const runtime = await createWorkerFromConfig(config, logger);

  const settle = (result: ShutdownResult): void => {
    process.exitCode = result.status === 'clean' && process.exitCode !== 1 ? 0 : 1;
  };
  const unbind = bindShutdownSignals(runtime.shutdownController, {
    onSettled: (result) => {
      settle(result);
      unbind();
    },
  });

  try {
    await runtime.start();
  } catch (error) {
    // The runtime already logged the classified failure and closed what it owns.
    if (!(error instanceof WorkerStartAbortedError)) process.exitCode = 1;
    settle(await runtime.shutdown('start_failed'));
    unbind();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Workloom worker failed to start: ${error instanceof Error ? error.name : 'unknown error'}\n`);
  process.exitCode = 1;
});
