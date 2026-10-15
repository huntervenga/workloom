// Runs `npm <args>` from the repository root with the root .env applied.
// Usage: node --env-file-if-exists=.env scripts/with-env.mjs <npm args...>
// Node's --env-file never overrides variables already present in the environment, so an
// explicitly exported value wins over .env, and a missing .env is not an error.
// Signals are forwarded to npm; its exit code or terminating signal is passed through.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node --env-file-if-exists=.env scripts/with-env.mjs <npm args...>');
  process.exit(2);
}

// Reuse the npm that launched us when possible; fall back to PATH.
const npmCli = process.env.npm_execpath;
const child =
  npmCli && npmCli.endsWith('.js')
    ? spawn(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' })
    : spawn('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

function forward(signal) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
// One handler per signal, bound to its name, so exit can remove exactly these listeners.
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => forward(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);

child.on('error', (error) => {
  console.error(`[with-env] could not start npm: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler);
  if (signal) {
    // Re-raise so callers (concurrently, Playwright, shells) see the same termination.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
