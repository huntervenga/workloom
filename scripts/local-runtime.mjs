#!/usr/bin/env node
// Existing local synthetic installation only. No build, schema or data initialization.
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
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
const WORKER_LOG = join(RUNTIME, 'worker.log');
const MAX_WORKER_LOG_BYTES = 1024 * 1024;
export const WORKER_QUEUES = [
  'workloom.recurrence.dead_letter.v1', 'workloom.recurrence.materialize.v1',
  'workloom.planning.cutoff.dead_letter.v1', 'workloom.planning.cutoff.v1',
];
const WORKER_HEALTH_MAX_AGE_MS = 90_000;

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
  if (service === 'worker') return identity.cwd === join(root, 'apps/worker')
    && new RegExp(`^${nodePrefix} (?:dist/main\\.js|${escapeRegExp(join(root, 'apps/worker/dist/main.js'))})$`).test(identity.command);
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
  if (environment.APP_ENV !== 'local' || !['dev', 'shared'].includes(environment.AUTH_MODE)) throw new Error('Only APP_ENV=local with AUTH_MODE=dev or shared is supported.');
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
    if (!isExpectedService(service, identity) || (service === 'worker' && !validWorkerRecord(identity))) throw new Error('Runtime state contains an unverified process record; refusing process control.');
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
    if (service !== 'worker') {
      const current = listener(service);
      if (current && !sameIdentity(expected, current)) throw new Error(`Stored ${service} is no longer the port owner; refusing.`);
    }
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

async function start(withWorker = false) {
  const env = environment(); const pg = cluster(); const state = readState();
  // Validate every occupied port before starting anything. No state cleanup can hide an unknown listener.
  const existing = Object.fromEntries(Object.keys(PORTS).map(service => [service, listener(service)]));
  const workers = workerInventory();
  if (withWorker) assertNoForeignWorkers(state.owned.worker, workers);
  const observations = Object.fromEntries(Object.entries(state.owned).map(([service, expected]) => [service, {
    current: processIdentity(expected.pid), definitelyDead: definitelyDead(expected.pid),
    listener: service === 'worker' ? (workers.length === 1 ? workers[0] : null) : existing[service],
  }]));
  state.owned = reconcileStartOwnership(state.owned, observations);
  if (withWorker) {
    workerEnvironment(env); requireWorkerBuild();
    if (existing.postgres && !sameIdentity(state.owned.postgres, existing.postgres)) throw new Error('Managed worker requires the existing healthy helper-owned PostgreSQL process; no process was adopted.');
  }
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
  if (withWorker) await startWorker(state, env, pg);
  else console.log(`worker: ${state.owned.worker ? 'existing managed process preserved; health was not certified by start' : 'not started; automatic processing is not certified'}`);
  console.log('Local synthetic app: http://127.0.0.1:4310 — development UI: http://127.0.0.1:4311');
}

export async function managedStopSequence(ports) {
  await ports.preflight();
  await ports.worker();
  for (const service of ['web', 'api', 'postgres']) await ports.service(service);
}

async function stop() {
  const state = readState();
  let pg;
  await managedStopSequence({
    preflight() {
      assertNoForeignWorkers(state.owned.worker, workerInventory()); // before any app or database signal
      validateOwned(state);
      pg = state.owned.postgres ? cluster() : null;
      if (state.owned.postgres) for (const service of ['api', 'web']) {
        const current = listener(service);
        if (current && !state.owned[service]) throw new Error(`Preexisting ${service} still runs; refusing to stop its database.`);
      }
    },
    worker: async () => { if (state.owned.worker) await stopWorker(state); },
    async service(service) {
      const identity = state.owned[service]; if (!identity) return;
      if (!sameIdentity(identity, processIdentity(identity.pid))) throw new Error(`${service} identity changed after preflight; refusing.`);
      if (service === 'postgres') {
        assertNoForeignWorkers(undefined, workerInventory());
        run(join(pg, 'pg_ctl'), ['-D', DATA, '-m', 'fast', '-t', '10', '-w', 'stop']);
      } else {
        process.kill(identity.pid, 'SIGTERM');
        for (let attempt = 0; attempt < 60 && sameIdentity(identity, processIdentity(identity.pid)); attempt++) await delay(200);
        if (sameIdentity(identity, processIdentity(identity.pid))) throw new Error(`${service} has not exited gracefully; no forced kill was sent.`);
      }
      state.owned = Object.fromEntries(Object.entries(state.owned).filter(([name]) => name !== service));
      saveState(state); console.log(`${service}: stopped helper-owned process`);
    },
  });
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
  const workerStatus = describeWorker(state.owned.worker);
  console.log(`worker: ${workerStatus.message}`);
  if (!healthy || !workerStatus.healthy) process.exitCode = 1;
}

export function parseRuntimeArguments(args) {
  const [action, flag] = args;
  if (!['doctor', 'start', 'stop', 'worker-start', 'worker-stop'].includes(action)
    || args.length > 2 || (flag !== undefined && (action !== 'start' || flag !== '--worker'))) {
    throw new Error('Usage: node scripts/local-runtime.mjs doctor|start [--worker]|stop|worker-start|worker-stop');
  }
  return { action, withWorker: flag === '--worker' };
}

export function workerEnvironment(env) {
  // info/debug/trace preserve the evidence this manager needs; no silent policy override.
  const level = env.LOG_LEVEL?.trim() || 'info';
  if (!['info', 'debug', 'trace'].includes(level)) throw new Error('Managed worker needs LOG_LEVEL=info, debug or trace for startup, health and drain evidence.');
  const raw = env.WORKER_SHUTDOWN_TIMEOUT_MS?.trim() || '10000';
  const shutdownTimeoutMs = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1000 || shutdownTimeoutMs > 120000) throw new Error('WORKER_SHUTDOWN_TIMEOUT_MS must be an integer from 1000 to 120000.');
  return { env: { ...env, LOG_LEVEL: level }, shutdownTimeoutMs };
}

export function validWorkerRecord(record) {
  return !!record && Number.isSafeInteger(record.logOffset) && record.logOffset >= 0
    && typeof record.launchedAt === 'string' && Number.isFinite(Date.parse(record.launchedAt))
    && typeof record.logDevice === 'string' && /^\d{1,30}$/.test(record.logDevice)
    && typeof record.logInode === 'string' && /^\d{1,30}$/.test(record.logInode)
    && Number.isInteger(record.shutdownTimeoutMs) && record.shutdownTimeoutMs >= 1000 && record.shutdownTimeoutMs <= 120000
    && (record.startupConfirmedAt === undefined || (typeof record.startupConfirmedAt === 'string'
      && Number.isFinite(Date.parse(record.startupConfirmedAt)) && Date.parse(record.startupConfirmedAt) >= Date.parse(record.launchedAt)));
}

/** Candidates are never adopted, including dev/tsx/npm wrappers that are not our exact compiled command. */
export function isPossibleWorker(identity, root = ROOT) {
  return !!identity && /^(?:[^\s]*\/)?(?:node|tsx|npm|npx)(?:\s|$)/.test(identity.command) && (identity.cwd === join(root, 'apps/worker')
    || identity.command?.includes(join(root, 'apps/worker/'))
    || (identity.cwd === root && /(?:apps\/worker\/(?:dist\/main\.js|src\/main\.ts)|--workspace(?:=|\s+)@workloom\/worker|(?:^|\s)-w\s+@workloom\/worker)(?:\s|$)/.test(identity.command)));
}

function workerInventory() {
  // Inspect command text in memory only. No unrelated command line or environment is printed or persisted.
  const rows = run('/bin/ps', ['-axo', 'pid=,command=']).split('\n');
  const found = [];
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row);
    if (!match || !/(?:dist\/main\.js|src\/main\.ts|apps\/worker|@workloom\/worker)/.test(match[2])) continue;
    const pid = Number(match[1]);
    if (pid < 2) continue;
    const identity = processIdentity(pid);
    if (!identity) {
      if (definitelyDead(pid)) continue;
      throw new Error('A possible worker process could not be inspected; refusing process control.');
    }
    if (isPossibleWorker(identity)) found.push(identity);
  }
  return found;
}

export function assertNoForeignWorkers(owned, candidates) {
  if (candidates.length > 1 || candidates.some(candidate => !sameIdentity(owned, candidate))) {
    throw new Error('A manual, foreign or duplicate worker is running; refusing without adopting or signalling it.');
  }
}

export function reconcileWorkerStart(owned, current, dead, candidates) {
  assertNoForeignWorkers(owned, candidates);
  if (!owned) return null;
  if (sameIdentity(owned, current) && candidates.length === 1 && sameIdentity(owned, candidates[0])) return owned;
  if (current === null && dead === true && candidates.length === 0) return null;
  throw new Error('Stored worker identity is live, reused or uncertain; refusing startup.');
}

/** Parse only complete, bounded log records from this launch, never expose their raw contents. */
export function assessWorkerEvidence(text, record, now = Date.now(), options = {}) {
  const records = [];
  let malformed = false;
  const raw = text.split('\n');
  if (raw.at(-1) !== '') malformed = true; // A concurrent partial write is unconfirmed until the next observation.
  for (const line of raw.slice(0, -1)) {
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { malformed = true; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.service !== 'worker'
      || typeof parsed.event !== 'string' || typeof parsed.time !== 'string' || !Number.isFinite(Date.parse(parsed.time))) { malformed = true; continue; }
    const at = Date.parse(parsed.time);
    if (at < Date.parse(record.launchedAt) || at > now + 1000) { malformed = true; continue; }
    records.push(parsed);
  }
  if (malformed) return { ready: false, status: 'unconfirmed', reason: 'malformed_log', cleanStop: false };
  const latest = name => records.findLast(item => item.event === name);
  const started = latest('worker.started');
  const health = latest('worker.health');
  const cutoff = latest('worker.health_cutoff');
  const discovery = latest('worker.health_discovery');
  const healthAt = health ? Date.parse(health.time) : NaN;
  const healthFailure = latest('worker.health_failed');
  // A failed observation invalidates older success immediately, including equal-millisecond log records.
  const supersedesFailure = !healthFailure || (records.indexOf(health) > records.indexOf(healthFailure)
    && healthAt >= Date.parse(healthFailure.time));
  const fresh = Number.isFinite(healthAt) && now - healthAt <= WORKER_HEALTH_MAX_AGE_MS;
  const partOfHealth = item => item && Date.parse(item.time) >= healthAt && Date.parse(item.time) - healthAt <= 5000;
  const queueRows = WORKER_QUEUES.map(name => records.findLast(item => item.event === 'worker.health_queue' && item.jobName === name));
  const ready = !!((record.startupConfirmedAt || started) && !latest('worker.shutdown_started') && !latest('worker.start_failed') && supersedesFailure && fresh && health?.lifecycle === 'running'
    && ['ok', 'degraded'].includes(health?.status) && partOfHealth(cutoff) && ['ok', 'degraded'].includes(cutoff.status)
    && partOfHealth(discovery) && Number.isInteger(discovery.consecutiveFailures) && discovery.consecutiveFailures >= 0
    && queueRows.every(item => partOfHealth(item) && item.state === 'ready'));
  const shutdownStart = records.findLast(item => item.event === 'worker.shutdown_started' && item.reason === 'SIGTERM'
    && Date.parse(item.time) >= (options.stopRequestedAt ?? Number.POSITIVE_INFINITY));
  const shutdown = latest('worker.shutdown_finished');
  const cleanStop = !!shutdownStart && shutdown?.reason === 'SIGTERM' && shutdown.result === 'clean'
    && Date.parse(shutdown.time) >= Date.parse(shutdownStart.time);
  return {
    ready,
    status: ready ? (health.status === 'degraded' || cutoff.status === 'degraded' || discovery.consecutiveFailures > 0 ? 'degraded' : 'ok') : 'unconfirmed',
    reason: ready ? 'fresh_health' : !supersedesFailure ? 'health_observation_failed' : fresh ? 'incomplete_health' : 'health_stale', cleanStop,
  };
}

export function validWorkerLogIdentity(record, stat) {
  return stat.regular === true && stat.device === record.logDevice && stat.inode === record.logInode
    && Number.isSafeInteger(stat.size) && stat.size >= record.logOffset;
}

function readWorkerEvidence(record, options) {
  let descriptor;
  try {
    descriptor = openSync(WORKER_LOG, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!validWorkerLogIdentity(record, { device: stat.dev.toString(), inode: stat.ino.toString(), regular: stat.isFile(), size: Number(stat.size) })) throw new Error('Worker log changed identity or was truncated.');
    const size = Number(stat.size), start = Math.max(record.logOffset, size - MAX_WORKER_LOG_BYTES);
    const bytes = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, start + offset);
      if (count === 0) throw new Error('Worker log changed during observation.');
      offset += count;
    }
    const text = bytes.toString('utf8');
    // When bounded tail reading cuts a record, discard that fragment, never a launch-boundary fragment.
    return assessWorkerEvidence(start === record.logOffset ? text : text.slice(text.indexOf('\n') + 1), record, Date.now(), options);
  } catch {
    return { ready: false, status: 'unconfirmed', reason: 'log_unavailable_or_changed', cleanStop: false };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function requireWorkerBuild() {
  for (const path of ['apps/worker/dist/main.js', 'packages/contracts/dist/index.js', 'packages/domain/dist/index.js', 'packages/db/dist/index.js']) {
    if (!existsSync(join(ROOT, path))) throw new Error('Compiled worker/dependencies missing; use the separate explicit build gate first.');
  }
}

async function startWorker(state, env, pg) {
  const configured = workerEnvironment(env); requireWorkerBuild();
  const candidates = workerInventory(), previous = state.owned.worker;
  const retained = reconcileWorkerStart(previous, previous ? processIdentity(previous.pid) : null,
    previous ? definitelyDead(previous.pid) : true, candidates);
  const postgres = listener('postgres');
  if (!sameIdentity(state.owned.postgres, postgres)) throw new Error('Managed worker requires the existing healthy helper-owned PostgreSQL process; no process was adopted.');
  if (!existsSync(join(pg, 'pg_isready'))) throw new Error('PostgreSQL readiness binary is missing; no worker was started.');
  run(join(pg, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(PORTS.postgres), '-t', '3']);
  if (retained) {
    const evidence = readWorkerEvidence(retained);
    if (!evidence.ready) throw new Error('Existing managed worker has no fresh complete health evidence; it was preserved. Inspect its private log.');
    console.log(`worker: already managed and running; health ${evidence.status}`); return;
  }
  delete state.owned.worker; saveState(state);
  const log = openSync(WORKER_LOG, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let stat;
  try { fchmodSync(log, 0o600); stat = fstatSync(log, { bigint: true }); }
  catch (error) { closeSync(log); throw error; }
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) { closeSync(log); throw new Error('Worker log is not a bounded regular file.'); }
  const launchedAt = new Date().toISOString();
  const cwd = join(ROOT, 'apps/worker'), target = join(cwd, 'dist/main.js');
  const child = spawn(process.execPath, [target], { cwd, env: configured.env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', () => reject(new Error('Could not start worker.'))); });
  child.unref();
  const identity = processIdentity(child.pid);
  if (!isExpectedService('worker', identity)) throw new Error('Started worker identity could not be verified; no signal was sent.');
  const record = { ...identity, launchedAt, logOffset: Number(stat.size), logDevice: stat.dev.toString(), logInode: stat.ino.toString(), shutdownTimeoutMs: configured.shutdownTimeoutMs };
  state.owned.worker = record; saveState(state);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!sameIdentity(record, processIdentity(record.pid))) throw new Error('Worker exited or changed identity during startup; inspect its private log. Ownership remains recorded.');
    assertNoForeignWorkers(record, workerInventory());
    const evidence = readWorkerEvidence(record);
    if (evidence.ready) {
      if (!sameIdentity(record, processIdentity(record.pid))) throw new Error('Worker identity changed after health observation; refusing readiness.');
      record.startupConfirmedAt = new Date().toISOString(); saveState(state);
      console.log(`worker: started; all four queues verified; health ${evidence.status}. Period completion requires its own evidence.`); return;
    }
    await delay(250);
  }
  throw new Error('Worker startup health was not confirmed within 60 seconds; it remains recorded for a safe worker-stop.');
}

/** Injected process/log/time ports let tests prove refusal/drain without inspecting or signalling real processes. */
export async function drainManagedWorker(record, ports) {
  if (!validWorkerRecord(record)) throw new Error('Worker ownership metadata is invalid; refusing signal.');
  if (!sameIdentity(record, ports.current())) throw new Error('Stored worker PID is stale or reused; refusing signal.');
  assertNoForeignWorkers(record, ports.candidates());
  const stopRequestedAt = ports.now();
  ports.signal(record.pid, 'SIGTERM');
  const deadline = stopRequestedAt + Math.max(30_000, record.shutdownTimeoutMs + 45_000);
  while (ports.now() < deadline) {
    const current = ports.current();
    if (!sameIdentity(record, current)) {
      if (current !== null) throw new Error('Worker PID identity changed while stopping; no further signal was sent.');
      if (ports.dead(record.pid)) {
        const evidence = ports.evidence(record, { stopRequestedAt });
        if (!evidence.cleanStop) throw new Error('Worker exited without verified clean SIGTERM drain evidence; ownership and other services were preserved.');
        ports.forget(); return;
      }
    }
    await ports.wait(200);
  }
  throw new Error('Worker has not completed a verified graceful stop within its finite budget; no forced kill was sent. Other services were preserved.');
}

async function stopWorker(state) {
  assertNoForeignWorkers(state.owned.worker, workerInventory());
  const record = state.owned.worker;
  if (!record) { console.log('worker: OFF; no managed process to stop and no automatic processing is certified.'); return; }
  await drainManagedWorker(record, {
    current: () => processIdentity(record.pid), candidates: workerInventory, dead: definitelyDead,
    signal: (pid, signal) => process.kill(pid, signal), now: Date.now, wait: delay,
    evidence: readWorkerEvidence,
    forget: () => { delete state.owned.worker; saveState(state); },
  });
  console.log('worker: stopped helper-owned process after verified clean SIGTERM drain');
}

export function workerDoctorStatus(owned, current, candidates, evidence) {
  if (!owned) return candidates.length === 0
    ? { healthy: true, message: 'OFF (optional); automatic processing is not operating through this helper' }
    : { healthy: false, message: 'manual/foreign worker present (not owned); health unconfirmed; no automatic processing is certified' };
  if (!sameIdentity(owned, current) || candidates.length !== 1 || !sameIdentity(owned, candidates[0])) return { healthy: false, message: 'stale, reused or ambiguous managed identity; health unconfirmed; process control will refuse' };
  return { healthy: evidence.ready && evidence.status === 'ok', message: evidence.ready
    ? `managed and running; fresh four-queue/cutoff/discovery health ${evidence.status}; period completion requires its own evidence`
    : 'managed process present; health stale, failed, malformed or incomplete; automatic processing is not certified' };
}

function describeWorker(owned) {
  return workerDoctorStatus(owned, owned ? processIdentity(owned.pid) : null, workerInventory(), owned ? readWorkerEvidence(owned) : null);
}

export async function runRuntimeAction({ action, withWorker }, ports) {
  if (action === 'doctor') return ports.doctor();
  if (action === 'start') return ports.start(withWorker);
  if (action === 'worker-start') return ports.workerStart();
  if (action === 'worker-stop') return ports.workerStop();
  return ports.stop();
}

async function main() {
  const { action, withWorker } = parseRuntimeArguments(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('This existing native installation helper currently supports macOS only.');
  if (!/^24\./.test(process.versions.node)) throw new Error('Use Node.js 24; see docs/26-local-runtime.md.');
  if (action === 'doctor') return doctor();
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 }); chmodSync(RUNTIME, 0o700);
  try { mkdirSync(LOCK, { mode: 0o700 }); } catch { throw new Error('Another runtime operation holds .local/runtime/operation.lock. Inspect before removing a stale lock.'); }
  try {
    await runRuntimeAction({ action, withWorker }, { doctor, start, stop,
      workerStart: () => startWorker(readState(), environment(), cluster()),
      workerStop: () => stopWorker(readState()),
    });
  } finally { rmSync(LOCK, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[local-runtime] ${error.message}`); process.exitCode = 1; });
}
