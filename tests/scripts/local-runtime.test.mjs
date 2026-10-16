import assert from 'node:assert/strict';
import test from 'node:test';
import { isExpectedService, reconcileStartOwnership, sameIdentity, validateLocalEnvironment } from '../../scripts/local-runtime.mjs';

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
