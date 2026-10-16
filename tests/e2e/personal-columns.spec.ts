// Personal preferences use real local API/DB; lost ACK forwards a committed command.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { meResponseSchema, personalTablePreferenceResponseSchema, planningPeriodResponseSchema, projectColumnsResponseSchema, taskFieldDefinitionResponseSchema, type ColumnChoice } from '@workloom/contracts';
import { apiCall, dailyFixture } from './support/daily-fixture.js';

type Fixture = Awaited<ReturnType<typeof dailyFixture>>;
const endpoint = (f: Fixture) => `${f.prefix}/projects/${f.project.id}/table-preferences/me`;
async function head(f: Fixture, request: APIRequestContext = f.request) { const r = await request.get(endpoint(f)); expect(r.status()).toBe(200); return personalTablePreferenceResponseSchema.parse(await r.json()).data; }
async function shared(f: Fixture) { const r = await f.request.get(`${f.prefix}/projects/${f.project.id}/columns`); expect(r.status()).toBe(200); return projectColumnsResponseSchema.parse(await r.json()).data; }
async function chooser(page: Page, unconfirmed = false) { await page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ }).click(); const dialog = page.getByRole('dialog', { name: 'My task columns', exact: true }); await expect(dialog.getByRole('checkbox').first()).toBeDisabled(); if (unconfirmed) { await expect(dialog.getByRole('button', { name: 'Use project defaults', exact: true })).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Retry original columns', exact: true })).toBeVisible(); } else await expect(dialog.getByRole('button', { name: 'Use project defaults', exact: true })).toBeEnabled(); return dialog; }
function choice(dialog: Locator, name: string) { return dialog.getByRole('listitem').filter({ has: dialog.page().getByText(name, { exact: true }) }).getByRole('checkbox'); }
async function close(dialog: Locator) { await dialog.getByRole('button', { name: 'Close', exact: true }).last().click(); }
async function save(page: Page, dialog: Locator, f: Fixture) { const done = page.waitForResponse(r => apiCall(r, 'PUT', endpoint(f))); await dialog.getByRole('button', { name: 'Save columns', exact: true }).click(); const r = await done; expect(r.status(), await r.text()).toBe(200); const result = personalTablePreferenceResponseSchema.parse(await r.json()).data; await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible(); return result; }
async function setup(f: Fixture) {
  const task = await f.createTask(`${f.token} columns`);
  const a = (await f.post('/fields', { projectId: f.project.id, name: 'QA text', type: 'text' }, taskFieldDefinitionResponseSchema)).data;
  const b = (await f.post('/fields', { projectId: f.project.id, name: 'QA number', type: 'number' }, taskFieldDefinitionResponseSchema)).data;
  const defaults = await shared(f);
  const r = await f.request.patch(`${f.prefix}/projects/${f.project.id}/columns`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: defaults.revision, columns: defaults.columns.map(column => ({ ...column, visible: true })) } });
  expect(r.status(), await r.text()).toBe(200); return { task, a, b, defaults: projectColumnsResponseSchema.parse(await r.json()).data };
}
const table = (page: Page) => page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Task', exact: true }) });
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }
for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Personal columns ${name}`, () => {
    test.use({ viewport });
    test('explicit save persists builtin/custom visibility and keyboard order on reload without changing team defaults', async ({ page, request, baseURL }, info) => {
      const f = await dailyFixture(request, baseURL, 'Personal column order'); const fixture = await setup(f);
      expect(await head(f)).toMatchObject({ revision: 0, columns: null, membershipId: f.own.id });
      await page.goto(f.path); const dialog = await chooser(page);
      await choice(dialog, 'Status').uncheck(); await choice(dialog, 'QA number').uncheck(); await choice(dialog, 'Participants').check();
      for (let i = 0; i < 3; i++) { const up = dialog.getByRole('button', { name: 'Move Due date up', exact: true }); await up.focus(); await up.press('Enter'); }
      expect((await head(f)).revision).toBe(0);
      const saved = await save(page, dialog, f); expect(saved.revision).toBe(1); expect(saved.columns?.[1]).toEqual({ column: { kind: 'builtin', key: 'dueDate' }, visible: true });
      expect(saved.columns).toContainEqual({ column: { kind: 'field', fieldId: fixture.b.id }, visible: false });
      await close(dialog); const headers = await table(page).getByRole('columnheader').allTextContents();
      expect(headers.slice(0, 3)).toEqual(['Task', 'Due date', 'Assignee']); expect(headers).toContain('Participants'); expect(headers).toContain('QA text'); expect(headers).not.toContain('Status'); expect(headers).not.toContain('QA number');
      await page.reload(); await expect(table(page).getByRole('columnheader', { name: 'Due date', exact: true })).toBeVisible(); expect(await table(page).getByRole('columnheader').allTextContents()).toEqual(headers);
      expect(await head(f)).toEqual(saved); expect(await shared(f)).toEqual(fixture.defaults); expect((await f.task(fixture.task.id)).revision).toBe(fixture.task.revision);
      await noOverflow(page); await page.screenshot({ path: info.outputPath(`personal-columns-${name}.png`) });
    });

    test('allowlisted viewer saves only their own choices; reset stores null at a positive revision and leaves owner/team settings unchanged', async ({ browser, request, baseURL }) => {
      const f = await dailyFixture(request, baseURL, 'Personal column actors'); const fixture = await setup(f);
      const owner = await head(f); const viewer = f.members.find(member => member.role === 'viewer'); if (!viewer) throw new Error('Existing synthetic viewer required.');
      const context = await browser.newContext({ baseURL, viewport });
      try {
        const session = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: viewer.userId } }); expect(session.status()).toBe(200); expect(meResponseSchema.parse(await session.json()).data.actor.id).toBe(viewer.userId);
        const page = await context.newPage(); await page.goto(f.path); let dialog = await chooser(page); await choice(dialog, 'Priority').check();
        const saved = await save(page, dialog, f); expect(saved).toMatchObject({ membershipId: viewer.id, revision: 1 }); await close(dialog); await page.reload(); await expect(table(page).getByRole('columnheader', { name: 'Priority', exact: true })).toBeVisible();
        dialog = await chooser(page); await dialog.getByRole('button', { name: 'Use project defaults', exact: true }).click(); expect((await head(f, context.request)).revision).toBe(1);
        const reset = await save(page, dialog, f); expect(reset).toMatchObject({ membershipId: viewer.id, revision: 2, columns: null }); expect(await head(f, context.request)).toEqual(reset);
        expect(await head(f)).toEqual(owner); expect(await shared(f)).toEqual(fixture.defaults); expect((await f.task(fixture.task.id)).revision).toBe(fixture.task.revision);
      } finally { await context.close(); }
    });

    test('committed lost ACK survives chooser remount; exact original retry fetches the newer authoritative head without rolling it back', async ({ page, request, baseURL }) => {
      const f = await dailyFixture(request, baseURL, 'Personal columns retry'); const fixture = await setup(f);
      const attempts: { key: string | undefined; body: string | null }[] = [];
      await page.route(`**${endpoint(f)}`, async route => { if (route.request().method() !== 'PUT') return route.continue(); attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(200); if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response: actual }); });
      await page.goto(f.path); let dialog = await chooser(page); await choice(dialog, 'Status').uncheck(); await dialog.getByRole('button', { name: 'Save columns', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Retry original columns', exact: true })).toBeVisible();
      const committed = await head(f); expect(committed.revision).toBe(1); await close(dialog);
      await page.getByRole('button', { name: 'Graph', exact: true }).click(); await page.getByRole('button', { name: 'Tasks', exact: true }).click();
      // A second legitimate tab commits head2 after head1's acknowledgement was lost.
      const columns: ColumnChoice[] = (committed.columns ?? []).map(item => item.column.kind === 'builtin' && item.column.key === 'status' ? { ...item, visible: true } : item.column.kind === 'builtin' && item.column.key === 'dueDate' ? { ...item, visible: false } : item);
      const next = await request.put(endpoint(f), { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: 1, columns } }); expect(next.status(), await next.text()).toBe(200); const authoritative = personalTablePreferenceResponseSchema.parse(await next.json()).data; expect(authoritative.revision).toBe(2);
      dialog = await chooser(page, true); await dialog.getByRole('button', { name: 'Retry original columns', exact: true }).click(); await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible();
      await expect(choice(dialog, 'Status')).toBeChecked(); await expect(choice(dialog, 'Due date')).not.toBeChecked(); await close(dialog);
      await expect(table(page).getByRole('columnheader', { name: 'Status', exact: true })).toBeVisible(); await expect(table(page).getByRole('columnheader', { name: 'Due date', exact: true })).toHaveCount(0);
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(await head(f)).toEqual(authoritative); expect(await shared(f)).toEqual(fixture.defaults);
    });

    test('hiding an inline editor retains its draft; weekly availability and field archive/restore reconcile without automatic preference writes', async ({ page, request, baseURL }) => {
      const f = await dailyFixture(request, baseURL, 'Personal columns reconciliation'); const fixture = await setup(f);
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'Column availability QA', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      let preferenceWrites = 0, taskWrites = 0;
      page.on('request', r => { const path = new URL(r.url()).pathname; if (r.method() === 'PUT' && path === endpoint(f)) preferenceWrites++; if (r.method() === 'PATCH' && path === `${f.prefix}/tasks/${fixture.task.id}`) taskWrites++; });
      await page.goto(f.path); await page.getByRole('button', { name: `Edit status for ${fixture.task.title}`, exact: true }).click();
      const inline = page.getByRole('form', { name: `Edit ${fixture.task.title} in the task table`, exact: true }); await inline.getByLabel('Status', { exact: true }).selectOption(f.progress.id); await inline.getByLabel('Status', { exact: true }).press('Tab'); expect(taskWrites).toBe(0);
      let dialog = await chooser(page); await choice(dialog, 'Status').uncheck(); await expect(choice(dialog, 'Personal weekly plan')).toBeChecked(); await expect(choice(dialog, 'Personal actual hours')).toBeChecked();
      const saved = await save(page, dialog, f); await close(dialog); await expect(inline).toHaveCount(0); await page.getByRole('button', { name: 'Resume original editor', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: fixture.task.title, exact: true }); await expect(drawer.getByLabel('Status', { exact: true })).toHaveValue(f.progress.id); expect((await f.task(fixture.task.id)).statusId).toBe(f.todo.id); expect(taskWrites).toBe(0);
      await drawer.getByRole('button', { name: 'Discard draft', exact: true }).click(); await expect(drawer.getByRole('button', { name: 'Discard draft', exact: true })).toHaveCount(0); await expect(drawer.getByLabel('Status', { exact: true })).toHaveValue(f.todo.id); await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0); await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(null);
      await page.getByLabel('Week for hours', { exact: true }).selectOption(period.id); await expect(table(page).getByRole('columnheader', { name: `Weekly plan · ${f.own.displayName}`, exact: true })).toBeVisible();
      await page.getByLabel('Week for hours', { exact: true }).selectOption(''); await expect(table(page).getByRole('columnheader', { name: /^Weekly plan/ })).toHaveCount(0); expect(preferenceWrites).toBe(1); expect(await head(f)).toEqual(saved);
      const updateField = async (expectedRevision: number, archived: boolean) => { const r = await request.patch(`${f.prefix}/fields/${fixture.a.id}`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision, archived } }); expect(r.status(), await r.text()).toBe(200); return taskFieldDefinitionResponseSchema.parse(await r.json()).data; };
      const archived = await updateField(fixture.a.revision, true); await page.reload(); await expect(table(page).getByRole('columnheader', { name: 'QA text', exact: true })).toHaveCount(0); dialog = await chooser(page); await expect(choice(dialog, 'QA text')).toBeDisabled(); await expect(choice(dialog, 'QA text')).toBeChecked(); await close(dialog); expect(await head(f)).toEqual(saved);
      await updateField(archived.revision, false); await page.reload(); await expect(table(page).getByRole('columnheader', { name: 'QA text', exact: true })).toBeVisible(); expect(preferenceWrites).toBe(1); expect(taskWrites).toBe(0); expect(await head(f)).toEqual(saved); await noOverflow(page);
    });
  });
}
