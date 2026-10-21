// Private compiled QA49318 + fake signed Auth49319 + disposable PostgreSQL only.
// No main sessions, customer records, token traces or production endpoints.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { workspaceResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, apiRead, createFixtureTask, freshProject } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ baseURL }, info) => {
  if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Explicit private QA49318 with one worker required.');
  if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth trace and video forbidden.');
  provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
});
test.afterAll(async () => { await provider?.close(); });
const path = (url: string) => new URL(url).pathname;
const name = () => `team-${randomUUID().slice(0, 8)}`;

test('owner selects company address; UUID and previous links canonicalize with task, view and fragment intact', async ({ page }, info) => {
  const f = await freshProject(page, provider, 'Company address');
  const task = await createFixtureTask(f, 'Keep this task context', { startDate: '2026-10-19', dueDate: '2026-10-23' });
  const first = name(), second = name();
  await page.goto(`${APP}/app/w/${f.workspaceId}`);
  const address = page.getByRole('textbox', { name: 'Company short name', exact: true });
  await address.fill(first); await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect.poll(() => path(page.url())).toBe(`/app/w/${first}`);
  await expect(page.getByRole('link', { name: 'Projects', exact: true }).first()).toHaveAttribute('href', `/app/w/${first}/projects`);
  const query = `?view=gantt&task=${task.id}#task-details`;
  const workspaceRequests: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/v1/workspaces/')) workspaceRequests.push(url.pathname); });
  await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}${query}`);
  await expect.poll(() => page.url()).toBe(`${APP}/app/w/${first}/projects/${f.projectId}${query}`);
  await expect(page.getByLabel('Task name', { exact: true })).toHaveValue(task.title);
  expect(workspaceRequests.every(value => !value.startsWith(`/api/v1/workspaces/${first}`))).toBe(true);
  await page.goto(`${APP}/app/w/${first}`);
  await address.fill(second); await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect.poll(() => path(page.url())).toBe(`/app/w/${second}`);
  await page.goto(`${APP}/app/w/${first}/projects/${f.projectId}${query}`);
  await expect.poll(() => page.url()).toBe(`${APP}/app/w/${second}/projects/${f.projectId}${query}`);
  const root = (await apiRead(page, f.prefix, workspaceResponseSchema)).data;
  expect(root.id).toBe(f.workspaceId); expect(root.slug).toBe(second); expect(root.slugAliases).toContain(first);
  await page.goto(`${APP}/app/w/${second}`);
  await expect(address).toHaveValue(second);
  await page.screenshot({ path: info.outputPath('company-address.png'), fullPage: false });
});

test('a lost save response exposes explicit retry with the same key, actor, body and revision', async ({ page }) => {
  const f = await freshProject(page, provider, 'Company retry'); const slug = name();
  await page.goto(`${APP}/app/w/${f.workspaceId}`);
  const commands: { key: string | undefined; actor: string | undefined; body: string | null }[] = [];
  page.on('request', request => { if (path(request.url()) === `${f.prefix}/slug` && request.method() === 'PATCH') commands.push({ key: request.headers()['idempotency-key'], actor: request.headers()['x-workloom-actor-id'], body: request.postData() }); });
  let first = true;
  await page.route(`**${f.prefix}/slug`, async route => {
    if (route.request().method() !== 'PATCH' || !first) { await route.continue(); return; }
    first = false; const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Private synthetic response loss' } }) });
  });
  await page.getByRole('textbox', { name: 'Company short name', exact: true }).fill(slug);
  await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The save may have completed.');
  expect(commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry same save', exact: true }).click();
  await expect.poll(() => path(page.url())).toBe(`/app/w/${slug}`);
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]);
  expect(commands[0]?.actor).toBe(f.actorId);
  const root = (await apiRead(page, f.prefix, workspaceResponseSchema)).data;
  expect(root.slug).toBe(slug); expect(root.slugRevision).toBe(2);
});
