import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKER_QUEUES, assessWorkerEvidence, assertNoForeignWorkers, drainManagedWorker, isExpectedService, isPossibleWorker, managedStopSequence, parseRuntimeArguments, reconcileStartOwnership, reconcileWorkerStart, runRuntimeAction, sameIdentity, validWorkerLogIdentity, validWorkerRecord, validateLocalEnvironment, workerDoctorStatus, workerEnvironment } from '../../scripts/local-runtime.mjs';

const root = '/sample/workloom';
const data = `${root}/.local/postgres/data`;
const api = { pid: 123, started: 'Fri Oct 16 10:28:38 2026', cwd: `${root}/apps/api`, command: 'node dist/main.js' };

test('process ownership rejects PID reuse, changed cwd/command, missing start time and unsafe PID', () => {
  assert.equal(sameIdentity(api, { ...api }), true);
  for (const change of [{ pid: 124 }, { started: 'another start' }, { cwd: '/another' }, { command: 'node another.js' }, { started: '' }]) assert.equal(sameIdentity(api, { ...api, ...change }), false);
  assert.equal(sameIdentity({ ...api, pid: 1 }, { ...api, pid: 1 }), false);
  assert.equal(sameIdentity(api, null), false);
});

test('occupied API/web ports require exact repository cwd and executable command', () => {
  assert.equal(isExpectedService('api', api, root, data), true);
  assert.equal(isExpectedService('api', { ...api, command: `/runtime/bin/node ${root}/apps/api/dist/main.js` }, root, data), true);
  for (const change of [{ cwd: `${root}/apps/web` }, { command: 'node dist/main.js --another' }, { command: 'node /another/dist/main.js' }]) assert.equal(isExpectedService('api', { ...api, ...change }, root, data), false);
  const web = { ...api, cwd: `${root}/apps/web`, command: `node ${root}/node_modules/.bin/vite` };
  assert.equal(isExpectedService('web', web, root, data), true);
  assert.equal(isExpectedService('web', { ...web, command: `${web.command} --host 0.0.0.0` }, root, data), false);
});

test('PostgreSQL ownership requires exact existing data directory and command', () => {
  const postgres = { ...api, cwd: data, command: `/opt/homebrew/Cellar/postgresql@17/17.5/bin/postgres -D ${data}` };
  assert.equal(isExpectedService('postgres', postgres, root, data), true);
  assert.equal(isExpectedService('postgres', { ...postgres, cwd: '/another/cluster' }, root, data), false);
  assert.equal(isExpectedService('postgres', { ...postgres, command: `${postgres.command}-other` }, root, data), false);
  assert.equal(isExpectedService('unknown', postgres, root, data), false);
});

test('runtime environment refuses remote or alternate cluster, URL options and nonlocal identity mode', () => {
  const env = { DATABASE_URL: 'postgres://synthetic:placeholder@127.0.0.1:55432/workloom_dev', APP_ENV: 'local', AUTH_MODE: 'dev' };
  assert.equal(validateLocalEnvironment(env), true);
  for (const change of [{ DATABASE_URL: 'postgres://user:placeholder@remote.invalid:55432/workloom' }, { DATABASE_URL: 'postgres://user:placeholder@127.0.0.1:5432/workloom' }, { DATABASE_URL: `${env.DATABASE_URL}?host=remote.invalid` }, { DATABASE_URL: 'invalid' }, { APP_ENV: 'production' }, { AUTH_MODE: 'shared' }, { PORT: '4312' }, { HOST: '0.0.0.0' }]) assert.throws(() => validateLocalEnvironment({ ...env, ...change }));
});


test('startup after reboot discards only proven-dead ownership with empty ports', () => {
  assert.deepEqual(reconcileStartOwnership({ api }, { api: { current: null, definitelyDead: true, listener: null } }), {});
  assert.deepEqual(reconcileStartOwnership({ api }, { api: { current: api, definitelyDead: false, listener: api } }), { api });
  for (const observation of [
    { current: { ...api, started: 'reused after reboot' }, definitelyDead: false, listener: null },
    { current: api, definitelyDead: false, listener: null },
    { current: null, definitelyDead: false, listener: null },
    { current: null, definitelyDead: true, listener: { ...api, pid: 999 } },
  ]) assert.throws(() => reconcileStartOwnership({ api }, { api: observation }));
  assert.throws(() => reconcileStartOwnership({ api }, {}));
});

const at = Date.parse('2026-10-16T12:00:00.000Z');
const worker = {
  ...api, cwd: `${root}/apps/worker`, command: `node ${root}/apps/worker/dist/main.js`,
  launchedAt: new Date(at - 1000).toISOString(), logOffset: 123, logDevice: '1', logInode: '987654', shutdownTimeoutMs: 10000,
};
const event = (name, fields = {}, stamp = at) => ({ service: 'worker', time: new Date(stamp).toISOString(), event: name, ...fields });
function healthRecords(stamp = at) {
  return [event('worker.started', {}, stamp), event('worker.health', { status: 'ok', lifecycle: 'running' }, stamp),
    event('worker.health_cutoff', { status: 'ok' }, stamp), event('worker.health_discovery', { consecutiveFailures: 0 }, stamp),
    ...WORKER_QUEUES.map(jobName => event('worker.health_queue', { jobName, state: 'ready' }, stamp))];
}
const serialized = records => `${records.map(item => JSON.stringify(item)).join('\n')}\n`;

test('optional worker actions are explicit and plain start dispatch never enables a worker', async () => {
  const calls = [];
  const ports = Object.fromEntries(['start', 'stop', 'workerStart', 'workerStop', 'doctor'].map(name => [name, async (...args) => calls.push([name, ...args])]));
  for (const args of [['start'], ['start', '--worker'], ['worker-start'], ['worker-stop'], ['doctor'], ['stop']]) await runRuntimeAction(parseRuntimeArguments(args), ports);
  assert.deepEqual(calls, [['start', false], ['start', true], ['workerStart'], ['workerStop'], ['doctor'], ['stop']]);
  for (const args of [[], ['restart'], ['start', '--all'], ['stop', '--worker'], ['worker-start', '--worker'], ['doctor', '--worker'], ['start', '--worker', 'extra']]) assert.throws(() => parseRuntimeArguments(args));
});

test('compiled worker identity is exact and possible manual/source/npm workers are detected without adopting unrelated commands', () => {
  assert.equal(isExpectedService('worker', worker, root, data), true);
  assert.equal(isExpectedService('worker', { ...worker, command: 'node dist/main.js' }, root, data), true);
  assert.equal(isExpectedService('worker', { ...worker, command: `/runtime/bin/node ${root}/apps/worker/dist/main.js` }, root, data), true);
  for (const change of [{ cwd: root }, { command: 'node dist/main.js --extra' }, { command: `node ${root}/apps/api/dist/main.js` }, { command: 'tsx src/main.ts' }]) assert.equal(isExpectedService('worker', { ...worker, ...change }, root, data), false);
  for (const identity of [worker, { ...worker, command: 'tsx watch src/main.ts' }, { ...worker, cwd: root }, { ...worker, cwd: root, command: 'npm run start --workspace @workloom/worker' }, { ...worker, cwd: root, command: 'node --import tsx apps/worker/src/main.ts' }]) assert.equal(isPossibleWorker(identity, root), true);
  for (const identity of [api, { ...worker, cwd: '/another', command: 'node dist/main.js' }, { ...worker, cwd: root, command: 'cat apps/worker/dist/main.js' }, { ...worker, command: 'vim README.md' }]) assert.equal(isPossibleWorker(identity, root), false);
});

test('worker metadata is bounded and requires private-log identity, launch boundary and finite drain configuration', () => {
  assert.equal(validWorkerRecord(worker), true);
  assert.equal(validWorkerRecord({ ...worker, startupConfirmedAt: new Date(at).toISOString() }), true);
  for (const change of [{ logOffset: -1 }, { logOffset: 1.5 }, { logOffset: Number.MAX_SAFE_INTEGER + 1 }, { logDevice: '../file' }, { logInode: undefined }, { launchedAt: 'invalid' }, { shutdownTimeoutMs: 0 }, { shutdownTimeoutMs: 120001 }, { startupConfirmedAt: new Date(at - 2000).toISOString() }]) assert.equal(validWorkerRecord({ ...worker, ...change }), false);
  assert.equal(workerEnvironment({}).shutdownTimeoutMs, 10000);
  assert.equal(workerEnvironment({ LOG_LEVEL: 'debug', WORKER_SHUTDOWN_TIMEOUT_MS: '120000' }).shutdownTimeoutMs, 120000);
  for (const env of [{ LOG_LEVEL: 'silent' }, { LOG_LEVEL: 'warn' }, { WORKER_SHUTDOWN_TIMEOUT_MS: '0' }, { WORKER_SHUTDOWN_TIMEOUT_MS: '1000.5' }, { WORKER_SHUTDOWN_TIMEOUT_MS: '120001' }]) assert.throws(() => workerEnvironment(env));
});

test('startup preserves an owned live worker and discards only a proven-dead worker without other candidates', () => {
  assert.deepEqual(reconcileWorkerStart(worker, worker, false, [worker]), worker);
  assert.equal(reconcileWorkerStart(worker, null, true, []), null);
  assert.equal(reconcileWorkerStart(undefined, null, true, []), null);
  assert.deepEqual(reconcileStartOwnership({ api, worker }, {
    api: { current: api, listener: api, definitelyDead: false }, worker: { current: worker, listener: worker, definitelyDead: false },
  }), { api, worker });
  for (const [owned, current, dead, candidates] of [
    [undefined, null, true, [worker]], [worker, { ...worker, started: 'reused' }, false, []],
    [worker, null, false, []], [worker, worker, false, []], [worker, worker, false, [worker, { ...worker, pid: 456 }]],
  ]) assert.throws(() => reconcileWorkerStart(owned, current, dead, candidates));
  assert.throws(() => assertNoForeignWorkers(undefined, [worker]));
});

test('startup and doctor require fresh complete four-queue/cutoff/discovery evidence from this launch', () => {
  assert.deepEqual(assessWorkerEvidence(serialized(healthRecords()), worker, at), { ready: true, status: 'ok', reason: 'fresh_health', cleanStop: false });
  const afterTail = { ...worker, startupConfirmedAt: new Date(at).toISOString() };
  assert.equal(assessWorkerEvidence(serialized(healthRecords().slice(1)), afterTail, at).ready, true);
  assert.equal(assessWorkerEvidence(serialized(healthRecords().slice(1)), worker, at).ready, false);
  assert.equal(assessWorkerEvidence(serialized(healthRecords()), worker, at + 90001).ready, false);
  for (const incomplete of [
    healthRecords().slice(0, -1), healthRecords().filter(row => row.event !== 'worker.health_cutoff'),
    healthRecords().filter(row => row.event !== 'worker.health_discovery'),
    healthRecords().map(row => row.event === 'worker.health_queue' ? { ...row, state: 'missing' } : row),
    healthRecords().map(row => row.event === 'worker.health' ? { ...row, lifecycle: 'stopping' } : row),
    healthRecords().map(row => row.event === 'worker.health' ? { ...row, status: 'down' } : row),
    healthRecords().map(row => row.event === 'worker.health_discovery' ? { ...row, consecutiveFailures: -1 } : row),
    healthRecords().map(row => row.event === 'worker.health_queue' ? { ...row, time: new Date(at - 1).toISOString() } : row),
  ]) assert.equal(assessWorkerEvidence(serialized(incomplete), worker, at).ready, false);
});

test('stale, malformed, partial, foreign and pre-launch log rows never establish healthy operation', () => {
  for (const text of ['not JSON\n', `${serialized(healthRecords())}{"partial":`, serialized([{ ...event('worker.health'), service: 'api' }]), serialized(healthRecords(at - 2000)), serialized(healthRecords(at + 2000)), '']) assert.equal(assessWorkerEvidence(text, worker, at).ready, false);
  const degraded = healthRecords().map(row => row.event === 'worker.health' ? { ...row, status: 'degraded' } : row);
  const evidence = assessWorkerEvidence(serialized(degraded), worker, at);
  assert.equal(evidence.ready, true); assert.equal(evidence.status, 'degraded');
  assert.equal(workerDoctorStatus(worker, worker, [worker], evidence).healthy, false);
  assert.match(workerDoctorStatus(worker, worker, [worker], evidence).message, /degraded/);
});

test('doctor reports optional OFF truthfully and refuses to certify unowned, stale or malformed running workers', () => {
  const off = workerDoctorStatus(undefined, null, [], null);
  assert.equal(off.healthy, true); assert.match(off.message, /OFF.*optional/); assert.match(off.message, /not operating/);
  assert.equal(workerDoctorStatus(undefined, worker, [worker], null).healthy, false);
  assert.equal(workerDoctorStatus(worker, { ...worker, started: 'reused' }, [worker], { ready: true, status: 'ok' }).healthy, false);
  assert.equal(workerDoctorStatus(worker, worker, [worker], { ready: false, status: 'unconfirmed' }).healthy, false);
  assert.equal(workerDoctorStatus(worker, worker, [worker], { ready: true, status: 'ok' }).healthy, true);
});

function drainPorts(changes = {}) {
  const calls = []; let clock = at, running = true;
  const ports = {
    current: () => running ? worker : null, candidates: () => [worker], dead: () => !running,
    signal: (pid, signal) => calls.push(['signal', pid, signal]), now: () => clock,
    wait: async ms => { clock += ms; running = false; },
    evidence: (record, { stopRequestedAt }) => assessWorkerEvidence(serialized([
      ...healthRecords(), event('worker.shutdown_started', { reason: 'SIGTERM' }, stopRequestedAt),
      event('worker.shutdown_finished', { reason: 'SIGTERM', result: 'clean' }, stopRequestedAt + 1),
    ]), record, clock, { stopRequestedAt }),
    forget: () => calls.push(['forget']),
    ...changes,
  };
  return { ports, calls, advance: ms => { clock += ms; } };
}

test('owned worker receives one SIGTERM and is forgotten only after actual disappearance and clean drain evidence', async () => {
  const { ports, calls } = drainPorts();
  await drainManagedWorker(worker, ports);
  assert.deepEqual(calls, [['signal', worker.pid, 'SIGTERM'], ['forget']]);
});

test('drain refuses reused identities, invalid records and manual duplicates before any signal', async () => {
  for (const change of [{ current: () => ({ ...worker, started: 'reused' }) }, { candidates: () => [worker, { ...worker, pid: 456 }] }, { candidates: () => [{ ...worker, pid: 456 }] }]) {
    const { ports, calls } = drainPorts(change);
    await assert.rejects(drainManagedWorker(worker, ports)); assert.deepEqual(calls, []);
  }
  const { ports, calls } = drainPorts();
  await assert.rejects(drainManagedWorker({ ...worker, logOffset: -1 }, ports)); assert.deepEqual(calls, []);
});

test('drain timeout never sends SIGKILL or forgets a running process', async () => {
  const h = drainPorts({ current: () => worker });
  h.ports.wait = async () => h.advance(30000);
  await assert.rejects(drainManagedWorker(worker, h.ports), /finite budget.*no forced kill/);
  assert.deepEqual(h.calls, [['signal', worker.pid, 'SIGTERM']]);
});

test('exit without clean evidence and PID reuse during drain preserve ownership and send no further signal', async () => {
  const h = drainPorts({ evidence: () => ({ cleanStop: false }) });
  await assert.rejects(drainManagedWorker(worker, h.ports), /without verified clean/);
  assert.deepEqual(h.calls, [['signal', worker.pid, 'SIGTERM']]);
  let checks = 0;
  const reused = drainPorts({ current: () => ++checks === 1 ? worker : { ...worker, started: 'new process' } });
  await assert.rejects(drainManagedWorker(worker, reused.ports), /identity changed/);
  assert.deepEqual(reused.calls, [['signal', worker.pid, 'SIGTERM']]);
});

test('a historical, failed, malformed or pre-signal shutdown cannot certify this stop', () => {
  for (const records of [
    [event('worker.shutdown_finished', { result: 'clean', reason: 'SIGTERM' })],
    [event('worker.shutdown_started', { reason: 'SIGTERM' }, at - 1), event('worker.shutdown_finished', { result: 'clean', reason: 'SIGTERM' })],
    [event('worker.shutdown_started', { reason: 'SIGTERM' }), event('worker.shutdown_finished', { result: 'failed', reason: 'SIGTERM' })],
    [event('worker.shutdown_started', { reason: 'SIGINT' }), event('worker.shutdown_finished', { result: 'clean', reason: 'SIGINT' })],
  ]) assert.equal(assessWorkerEvidence(serialized(records), worker, at, { stopRequestedAt: at }).cleanStop, false);
});

test('full stop preflights foreign workers before any mutation and requires worker drain before app/database stops', async () => {
  const calls = [];
  const ports = { preflight: async () => calls.push('preflight'), worker: async () => calls.push('worker'), service: async service => calls.push(service) };
  await managedStopSequence(ports); assert.deepEqual(calls, ['preflight', 'worker', 'web', 'api', 'postgres']);
  calls.length = 0;
  await assert.rejects(managedStopSequence({ ...ports, preflight: () => assertNoForeignWorkers(undefined, [worker]) })); assert.deepEqual(calls, []);
  await assert.rejects(managedStopSequence({ ...ports, worker: async () => { calls.push('worker'); throw new Error('Drain unconfirmed'); } }));
  assert.deepEqual(calls, ['preflight', 'worker']);
});


test('replaced, truncated and nonregular worker log metadata is rejected before evidence is read', () => {
  const stat = { device: worker.logDevice, inode: worker.logInode, regular: true, size: worker.logOffset + 100 };
  assert.equal(validWorkerLogIdentity(worker, stat), true);
  for (const change of [{ device: '2' }, { inode: 'other' }, { regular: false }, { size: worker.logOffset - 1 }, { size: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(validWorkerLogIdentity(worker, { ...stat, ...change }), false);
});

test('shutdown or startup failure invalidates otherwise fresh running health immediately', () => {
  for (const name of ['worker.shutdown_started', 'worker.start_failed']) assert.equal(assessWorkerEvidence(serialized([...healthRecords(), event(name)]), worker, at).ready, false);
});

test('a later health observation failure invalidates an earlier complete success within its freshness window', () => {
  const records = [...healthRecords(), event('worker.health_failed', { error: { name: 'Error' } }, at + 1000)];
  const evidence = assessWorkerEvidence(serialized(records), worker, at + 2000);
  assert.equal(evidence.ready, false);
  assert.equal(workerDoctorStatus(worker, worker, [worker], evidence).healthy, false);
  // Millisecond timestamp collisions still follow the append order of the launch log.
  assert.equal(assessWorkerEvidence(serialized([...healthRecords(), event('worker.health_failed')]), worker, at).ready, false);
});

test('health observation failure recovers only after a later complete success with all four queues', () => {
  const failed = [...healthRecords(), event('worker.health_failed', {}, at + 1000)];
  assert.equal(assessWorkerEvidence(serialized([...failed, ...healthRecords(at + 2000).slice(0, -1)]), worker, at + 2000).ready, false);
  const recovered = assessWorkerEvidence(serialized([...failed, ...healthRecords(at + 2000)]), worker, at + 2000);
  assert.equal(recovered.ready, true);
  assert.equal(workerDoctorStatus(worker, worker, [worker], recovered).healthy, true);
  assert.equal(assessWorkerEvidence(serialized([...healthRecords(), event('worker.health_failed'), ...healthRecords()]), worker, at).ready, true);
});
