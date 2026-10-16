// Coordinator-only GET probe. Start JUST before a coordinated build, never as a daemon.
// Usage: node tests/e2e/support/old-tab-upgrade.mjs <private-evidence-directory>
// After ready.json appears, coordinator builds/restarts then writes continue.json:
// {"approved":true,"expectedNewEntrySha256":"<actual new entry hash>"}.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { writePrivateJson } from '../../../scripts/private-json.mjs';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('Supply one fresh private evidence directory.');
const output = resolve(directory);
if (existsSync(output)) throw new Error('Evidence directory already exists; refuse to reuse a handoff.');
mkdirSync(output, { recursive: true, mode: 0o700 });
const origin = 'http://127.0.0.1:4310';
const path = '/w/31800692-b5ab-4c59-87c9-118d9ea8eac9/projects/9266f142-b72a-40b8-bb86-350d6df7c209';
const sha = value => createHash('sha256').update(value).digest('hex');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const writes = [], failures = [], errors = [], resources = [], routes = [];
const evidence = { startedAtUtc: new Date().toISOString(), origin, path, writes, failures, errors, resources, routes };
page.on('request', request => { if (!['GET','HEAD','OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: new URL(request.url()).pathname }); });
page.on('response', response => { if (new URL(response.url()).origin === origin) { resources.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] }); if (response.status() >= 400) failures.push({ url: response.url(), status: response.status() }); } });
page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
page.on('pageerror', error => errors.push(error.message));
page.on('framenavigated', frame => { if (frame === page.mainFrame()) routes.push({ at: new Date().toISOString(), url: frame.url() }); });
try {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Product launch', exact: true })).toBeVisible();
  const entry = await page.locator('script[type="module"][src]').getAttribute('src');
  if (!entry || !entry.startsWith('/assets/index-')) throw new Error('Current entry asset is not identifiable.');
  const response = await context.request.get(entry); if (response.status() !== 200) throw new Error('Initial entry read failed.');
  const timeOrigin = await page.evaluate(() => globalThis.performance.timeOrigin);
  const loadedBefore = await page.evaluate(() => globalThis.performance.getEntriesByType('resource').map(row => row.name));
  if (loadedBefore.some(url => /\/WeeklyPage-.*\.js(?:$|\?)/.test(url))) throw new Error('Weekly lazy route was already loaded; probe is not genuine.');
  evidence.before = { entry, sha256: sha(await response.body()), timeOrigin, loadedBefore };
  writePrivateJson(resolve(output, 'ready.json'), { ...evidence.before, readyAtUtc: new Date().toISOString(), continued: false });
  process.stdout.write(`Old-tab probe ready: ${resolve(output, 'ready.json')}\n`);
  const expires = Date.now() + 180_000;
  const signal = resolve(output, 'continue.json');
  while (!existsSync(signal)) { if (Date.now() >= expires) throw new Error('Timed out waiting for coordinated build/restart handoff (180s).'); await new Promise(done => globalThis.setTimeout(done, 500)); }
  const instruction = JSON.parse(readFileSync(signal, 'utf8'));
  if (instruction.approved !== true || !/^[a-f0-9]{64}$/.test(instruction.expectedNewEntrySha256 ?? '')) throw new Error('Invalid explicit build handoff.');
  const html = await context.request.get(path); if (html.status() !== 200) throw new Error('New HTML read failed.');
  const newEntry = (await html.text()).match(/<script[^>]+src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  if (!newEntry) throw new Error('New HTML entry not found.');
  const next = await context.request.get(newEntry); if (next.status() !== 200) throw new Error('New entry read failed.');
  const newHash = sha(await next.body()); if (newHash !== instruction.expectedNewEntrySha256 || newHash === evidence.before.sha256) throw new Error('New entry does not match the changed coordinated build.');
  // SAME page/loaded JS. Do not reload/goto after the build; click the original lazy link.
  await page.getByRole('link', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Weekly plan', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Period', { exact: true })).toHaveValue('');
  const afterTimeOrigin = await page.evaluate(() => globalThis.performance.timeOrigin);
  evidence.after = { newEntry, newEntrySha256: newHash, displayedEntry: await page.locator('script[type="module"][src]').getAttribute('src'), timeOrigin: afterTimeOrigin, sameDocument: afterTimeOrigin === timeOrigin, url: page.url(), loaded: await page.evaluate(() => globalThis.performance.getEntriesByType('resource').map(row => row.name)), globalOverflow: await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth) };
  expect(writes).toEqual([]); expect(evidence.after.globalOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve(output, 'old-tab-week.png'), fullPage: true });
  evidence.result = failures.length || errors.length ? 'route_ready_with_recorded_failures' : evidence.after.sameDocument ? 'route_ready_same_document' : 'route_ready_after_document_reload';
} catch (error) {
  evidence.result = 'failed'; evidence.error = error.message; process.exitCode = 1;
  await page.screenshot({ path: resolve(output, 'old-tab-failure.png'), fullPage: true }).catch(() => {});
} finally {
  evidence.finishedAtUtc = new Date().toISOString(); writePrivateJson(resolve(output, 'result.json'), evidence);
  await context.tracing.stop({ path: resolve(output, 'trace.zip') });
  await browser.close();
}
