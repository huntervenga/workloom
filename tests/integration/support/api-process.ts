// Starts the real API entrypoint as a child process on a free loopback port.
// `source` runs apps/api/src/main.ts through tsx (the `dev` script without watch);
// `dist` runs the compiled apps/api/dist/main.js exactly like `npm start`.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rawRequest } from './http.js';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface ApiProcessOptions {
  readonly entry: 'source' | 'dist';
  readonly databaseUrl: string;
  readonly env?: Record<string, string>;
}

export interface ApiProcess {
  readonly baseUrl: string;
  readonly port: number;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

function entryArgs(entry: ApiProcessOptions['entry']): string[] {
  if (entry === 'dist') {
    const main = join(repoRoot, 'apps/api/dist/main.js');
    if (!existsSync(main)) {
      throw new Error(`Missing ${main}. Run \`npm run build\` from the repository root before this test.`);
    }
    return [main];
  }
  const main = join(repoRoot, 'apps/api/src/main.ts');
  if (!existsSync(main)) throw new Error(`Missing ${main}: the API entrypoint is not implemented yet.`);
  return ['--import', 'tsx', main];
}

export async function startApi(options: ApiProcessOptions): Promise<ApiProcess> {
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    APP_ENV: 'local',
    AUTH_MODE: 'dev',
    NODE_ENV: options.entry === 'dist' ? 'production' : 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: options.databaseUrl,
    LOG_LEVEL: 'info',
    ...options.env,
  };

  const child = spawn(process.execPath, entryArgs(options.entry), { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  const baseUrl = `http://127.0.0.1:${port}`;
  const api: ApiProcess = { baseUrl, port, output: () => output, stop: () => stopChild(child) };
  await waitForLive(api, child);
  return api;
}

async function waitForLive(api: ApiProcess, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited with code ${child.exitCode} before /healthz/live answered:\n${api.output()}`);
    }
    try {
      const response = await rawRequest(api.baseUrl, '/healthz/live');
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await api.stop();
  throw new Error(`API did not answer /healthz/live within 30s:\n${api.output()}`);
}

/** Starts the process and resolves with its exit code and output; for configs that must be refused. */
export async function runApiExpectingExit(
  options: ApiProcessOptions,
  timeoutMs = 15_000,
): Promise<{ code: number | null; output: string }> {
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: options.databaseUrl,
    ...options.env,
  };
  const child = spawn(process.execPath, entryArgs(options.entry), { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, output });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
