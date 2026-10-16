#!/usr/bin/env node
// Existing local synthetic installation only. No build, schema or data initialization.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { writePrivateJson } from './private-json.mjs';

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const RUNTIME = join(ROOT, '.local/runtime');
const DATA = join(ROOT, '.local/postgres/data');
const STATE = join(RUNTIME, 'processes.json');
const LOCK = join(RUNTIME, 'operation.lock');
const PG_DEFAULT = '/opt/homebrew/Cellar/postgresql@17/17.5/bin';
const PORTS = { postgres: 55432, api: 4310, web: 4311 };

function run(binary, args) {
  try { return execFileSync(binary, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).trim(); }
  catch { throw new Error(`Could not inspect ${binary.split('/').at(-1)}; no process was signalled.`); }
}

export function sameIdentity(expected, actual) {
  return !!expected && !!actual && Number.isSafeInteger(expected.pid) && expected.pid > 1
    && expected.pid === actual.pid && typeof expected.started === 'string' && expected.started.length > 0
    && expected.started === actual.started && expected.cwd === actual.cwd && expected.command === actual.command;
}

export function isExpectedService(service, identity, root = ROOT, data = DATA) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 2 || !identity.started) return false;
  const nodePrefix = '(?:[^ ]*/)?node';
  if (service === 'api') return identity.cwd === join(root, 'apps/api')
    && new RegExp(`^${nodePrefix} (?:dist/main\\.js|${escapeRegExp(join(root, 'apps/api/dist/main.js'))})$`).test(identity.command);
  if (service === 'web') return identity.cwd === join(root, 'apps/web')
    && new RegExp(`^${nodePrefix} ${escapeRegExp(join(root, 'node_modules'))}/(?:\\.bin/vite|vite/bin/vite\\.js)$`).test(identity.command);
  if (service === 'postgres') return identity.cwd === data
    && new RegExp(`^/[^ ]*/postgres -D ${escapeRegExp(data)}$`).test(identity.command);
  return false;
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function validateLocalEnvironment(environment) {
  let url;
  try { url = new URL(environment.DATABASE_URL); } catch { throw new Error('DATABASE_URL is missing or invalid; its value is never printed.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55432'
    || !url.pathname || url.pathname === '/' || url.search || url.hash) throw new Error('DATABASE_URL must target this existing cluster on 127.0.0.1:55432 without URL options.');
  if (environment.APP_ENV !== 'local' || environment.AUTH_MODE !== 'dev') throw new Error('Only APP_ENV=local and AUTH_MODE=dev are supported.');
  if (environment.HOST && environment.HOST !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1.');
  if (environment.PORT && environment.PORT !== '4310') throw new Error('PORT must be 4310.');
  return true;
}

function environment() {
  if (!existsSync(join(ROOT, '.env'))) throw new Error('Existing .env is required. See docs/26-local-runtime.md; do not overwrite credentials.');
  const env = { ...parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')), ...process.env };
  validateLocalEnvironment(env);
  return { ...env, HOST: '127.0.0.1', PORT: '4310', NODE_ENV: 'production' };
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const started = run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
    const command = run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    const cwd = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'))?.slice(1);
    return started && command && cwd ? { pid, started, command, cwd } : null;
  } catch { return null; }
}

function listener(service) {
  let output;
  try { output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${PORTS[service]}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }); }
  catch (error) { if (error.status === 1) return null; throw new Error('Could not inspect local port ownership.'); }
  const pids = [...new Set(output.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  if (pids.length !== 1) throw new Error(`Port ${PORTS[service]} has ambiguous ownership; refusing.`);
  const identity = processIdentity(pids[0]);
  if (!isExpectedService(service, identity)) throw new Error(`Port ${PORTS[service]} is occupied by an unverified process; refusing. No process was signalled.`);
  return identity;
}

function cluster() {
  if (!existsSync(join(DATA, 'PG_VERSION')) || readFileSync(join(DATA, 'PG_VERSION'), 'utf8').trim() !== '17') throw new Error('Existing PostgreSQL 17 cluster not found. Startup never initializes or restores data.');
  const binary = process.env.WORKLOOM_PG_BIN || PG_DEFAULT;
  if (!isAbsolute(binary) || !existsSync(join(binary, 'postgres')) || !existsSync(join(binary, 'pg_ctl'))) throw new Error('PostgreSQL 17 binaries not found; set WORKLOOM_PG_BIN to an absolute bin directory.');
  if (!/^postgres \(PostgreSQL\) 17\./.test(run(join(binary, 'postgres'), ['--version']))) throw new Error('PostgreSQL binary major must match cluster version 17.');
  if (run(join(binary, 'postgres'), ['-D', DATA, '-C', 'port']) !== '55432'
    || run(join(binary, 'postgres'), ['-D', DATA, '-C', 'listen_addresses']) !== '127.0.0.1') throw new Error('Existing cluster must bind only 127.0.0.1:55432.');
  return binary;
}

function readState() {
  if (!existsSync(STATE)) return { version: 1, root: ROOT, owned: {} };
  let state;
  try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { throw new Error('Runtime state is unreadable; refusing process control.'); }
  if (state.version !== 1 || state.root !== ROOT || !state.owned || typeof state.owned !== 'object' || Array.isArray(state.owned)) throw new Error('Runtime state does not match this repository; refusing process control.');
  for (const [service, identity] of Object.entries(state.owned)) {
    if (!isExpectedService(service, identity)) throw new Error('Runtime state contains an unverified process record; refusing process control.');
  }
  return state;
}

function saveState(state) { writePrivateJson(STATE, state); }

async function ready(service) {
  if (service === 'postgres') return true;
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${PORTS[service]}${service === 'api' ? '/healthz/ready' : '/'}`, { signal: globalThis.AbortSignal.timeout(2000), redirect: 'error' });
    if (response.status !== 200) return false;
    if (service === 'api') {
      const body = await response.json();
      return body.status === 'ok' && body.checks?.database === 'ok' && body.checks?.schema === 'ok';
    }
    return response.headers.get('content-type')?.includes('text/html') && (await response.text()).includes('/@vite/client');
  } catch { return false; }
}

async function waitReady(service, expected) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!sameIdentity(expected, processIdentity(expected.pid))) throw new Error(`${service} exited or changed identity during startup; inspect its private log.`);
    const current = listener(service);
    if (current && !sameIdentity(expected, current)) throw new Error(`${service} port owner changed during startup; refusing.`);
    if (current && await ready(service)) return;
    await delay(200);
  }
  throw new Error(`${service} did not become ready; inspect .local/runtime/${service}.log. It remains recorded for a safe stop.`);
}

// Startup can forget a dead prior process, but cannot adopt or signal a reused PID.
export function reconcileStartOwnership(owned, observations) {
  const retained = {};
  for (const [service, expected] of Object.entries(owned)) {
    const observation = observations[service];
    if (observation && sameIdentity(expected, observation.current) && sameIdentity(expected, observation.listener)) retained[service] = expected;
    else if (observation && observation.definitelyDead === true && observation.current === null && observation.listener === null) continue;
    else throw new Error(`Stored ${service} identity is live, reused or uncertain; refusing startup.`);
  }
  return retained;
}

function definitelyDead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function validateOwned(state) {
  for (const [service, expected] of Object.entries(state.owned)) {
    if (!sameIdentity(expected, processIdentity(expected.pid))) throw new Error(`Stored ${service} PID is stale or reused; refusing all process control. See docs/26-local-runtime.md.`);
    const current = listener(service);
    if (current && !sameIdentity(expected, current)) throw new Error(`Stored ${service} is no longer the port owner; refusing.`);
  }
}

async function launchNode(service, state, env) {
  const cwd = join(ROOT, 'apps', service === 'api' ? 'api' : 'web');
  const target = service === 'api' ? join(cwd, 'dist/main.js') : join(ROOT, 'node_modules/vite/bin/vite.js');
  const log = openSync(join(RUNTIME, `${service}.log`), 'a', 0o600);
  chmodSync(join(RUNTIME, `${service}.log`), 0o600);
  const child = spawn(process.execPath, [target], { cwd, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', () => reject(new Error(`Could not start ${service}.`))); });
  child.unref();
  const identity = processIdentity(child.pid);
  if (!isExpectedService(service, identity)) throw new Error(`Started ${service} identity could not be verified; no signal was sent.`);
  state.owned[service] = identity; saveState(state);
  await waitReady(service, identity);
}

async function start() {
  const env = environment(); const pg = cluster(); const state = readState();
  // Validate every occupied port before starting anything. No state cleanup can hide an unknown listener.
  const existing = Object.fromEntries(Object.keys(PORTS).map(service => [service, listener(service)]));
  const observations = Object.fromEntries(Object.entries(state.owned).map(([service, expected]) => [service, {
    current: processIdentity(expected.pid), definitelyDead: definitelyDead(expected.pid), listener: existing[service],
  }]));
  state.owned = reconcileStartOwnership(state.owned, observations);
  saveState(state);
  for (const service of ['api', 'web']) if (existing[service] && !await ready(service)) throw new Error(`Existing ${service} failed readiness. Refusing to replace it.`);
  for (const path of ['apps/api/dist/main.js', 'apps/web/dist/index.html', 'packages/contracts/dist/index.js', 'packages/domain/dist/index.js', 'packages/db/dist/index.js', 'node_modules/vite/bin/vite.js']) {
    if (!existsSync(join(ROOT, path))) throw new Error('Build/dependencies missing. Run the documented explicit install/build steps first; startup does not build.');
  }
  if (!existing.postgres) {
    run(join(pg, 'pg_ctl'), ['-D', DATA, '-l', join(ROOT, '.local/postgres/server.log'), '-t', '10', '-w', 'start']);
    const identity = listener('postgres');
    if (!identity) throw new Error('Started cluster did not expose the expected listener.');
    state.owned.postgres = identity; saveState(state);
  }
  for (const service of ['api', 'web']) {
    if (existing[service]) console.log(`${service}: reusing verified ready process (not newly owned)`);
    else { await launchNode(service, state, env); console.log(`${service}: started and ready`); }
  }
  console.log('Local synthetic app: http://127.0.0.1:4310 — development UI: http://127.0.0.1:4311');
}

async function stop() {
  const state = readState(); validateOwned(state); // preflight all before signalling any
  const pg = state.owned.postgres ? cluster() : null;
  // Do not stop an owned DB while a verified but unowned app still uses this installation.
  if (state.owned.postgres) for (const service of ['api', 'web']) {
    const current = listener(service);
    if (current && !state.owned[service]) throw new Error(`Preexisting ${service} still runs; refusing to stop its database.`);
  }
  for (const service of ['web', 'api', 'postgres']) {
    const identity = state.owned[service]; if (!identity) continue;
    if (!sameIdentity(identity, processIdentity(identity.pid))) throw new Error(`${service} identity changed after preflight; refusing.`);
    if (service === 'postgres') run(join(pg, 'pg_ctl'), ['-D', DATA, '-m', 'fast', '-t', '10', '-w', 'stop']);
    else {
      process.kill(identity.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 60 && sameIdentity(identity, processIdentity(identity.pid)); attempt++) await delay(200);
      if (sameIdentity(identity, processIdentity(identity.pid))) throw new Error(`${service} has not exited gracefully; no forced kill was sent.`);
    }
    state.owned = Object.fromEntries(Object.entries(state.owned).filter(([name]) => name !== service)); saveState(state); console.log(`${service}: stopped helper-owned process`);
  }
  console.log('Stop complete. Preexisting/unowned processes were preserved.');
}

async function doctor() {
  environment(); cluster(); const state = readState();
  console.log('Configuration: local synthetic mode; existing PostgreSQL 17 cluster; credentials hidden.');
  let healthy = true;
  for (const service of Object.keys(PORTS)) {
    const current = listener(service); const owned = state.owned[service];
    if (owned && !sameIdentity(owned, processIdentity(owned.pid))) { console.log(`${service}: stale helper state — process control will refuse`); healthy = false; continue; }
    const ok = current && await ready(service); healthy &&= !!ok;
    console.log(`${service}: ${current ? ok ? 'verified and ready' : 'verified process, readiness failed' : 'stopped'}${owned ? ' (helper-owned)' : ' (not owned)'}`);
  }
  if (!healthy) process.exitCode = 1;
}

async function main() {
  const action = process.argv[2];
  if (!['doctor', 'start', 'stop'].includes(action) || process.argv.length !== 3) throw new Error('Usage: node scripts/local-runtime.mjs doctor|start|stop');
  if (process.platform !== 'darwin') throw new Error('This existing native installation helper currently supports macOS only.');
  if (!/^24\./.test(process.versions.node)) throw new Error('Use Node.js 24; see docs/26-local-runtime.md.');
  if (action === 'doctor') return doctor();
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 }); chmodSync(RUNTIME, 0o700);
  try { mkdirSync(LOCK, { mode: 0o700 }); } catch { throw new Error('Another runtime operation holds .local/runtime/operation.lock. Inspect before removing a stale lock.'); }
  try { if (action === 'start') await start(); else await stop(); } finally { rmSync(LOCK, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[local-runtime] ${error.message}`); process.exitCode = 1; });
}
