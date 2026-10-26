/**
 * Process entry point: load the optional repository .env (existing variables
 * win), validate configuration, migrate in hosted mode, listen, and close on
 * SIGINT/SIGTERM (Fastify stops accepting, in-flight requests finish, the
 * owned database pool closes).
 */
import { fileURLToPath } from 'node:url';

import { databaseErrorCode, loadEnvFileIfPresent, MigrationStateError, runMigrations } from '@workloom/db';

import { createApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  if (process.env.APP_ENV !== 'staging' && process.env.APP_ENV !== 'production') {
    loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
  }

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

  // Run inside the API entrypoint as well as pre-deploy: provider start-command
  // overrides must not let a new API start against a pending schema.
  if (config.appEnv === 'staging' || config.appEnv === 'production') {
    try {
      const result = await runMigrations(config.database.url, { requireLoopback: false });
      process.stdout.write(`${JSON.stringify({
        event: 'HOSTED_MIGRATION_COMPLETE', phase: 'startup',
        appliedCount: result.appliedNow.length, appliedMigrations: result.appliedNow,
        expectedCount: result.state.expectedCount,
      })}\n`);
    } catch (error) {
      const code = databaseErrorCode(error);
      process.stderr.write(`${JSON.stringify({
        error: 'HOSTED_MIGRATION_FAILED', phase: 'startup',
        reason: error instanceof MigrationStateError ? 'MIGRATION_HISTORY_INVALID' : 'MIGRATION_FAILED',
        ...(code && /^[A-Z0-9_]{2,40}$/.test(code) ? { code } : {}),
      })}\n`);
      process.exitCode = 1;
      return;
    }
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
    'Workloom API ready',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Workloom API failed to start: ${error instanceof Error ? error.name : 'unknown error'}\n`);
  process.exitCode = 1;
});
