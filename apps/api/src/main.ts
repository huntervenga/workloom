/**
 * Process entry point: load the optional repository .env (existing variables
 * win), validate configuration, listen on loopback, and close gracefully on
 * SIGINT/SIGTERM (Fastify stops accepting, in-flight requests finish, the
 * owned database pool closes).
 */
import { fileURLToPath } from 'node:url';

import { loadEnvFileIfPresent } from '@workloom/db';

import { createApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));

  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const app = await createApp(config);
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      process.stderr.write(`Received ${signal} again; exiting immediately.\n`);
      process.exit(1);
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    app.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        app.log.error({ err: error instanceof Error ? error.name : 'unknown' }, 'error during shutdown');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { appEnv: config.appEnv, authMode: config.authMode, nodeEnv: config.nodeEnv, database: config.database.description },
    'Workloom API ready (local synthetic mode, development identity)',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Workloom API failed to start: ${error instanceof Error ? error.name : 'unknown error'}\n`);
  process.exitCode = 1;
});
