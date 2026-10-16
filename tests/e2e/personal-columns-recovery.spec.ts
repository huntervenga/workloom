// Personal-column conflict recovery against the real local API/DB. Every 409 is produced by the
// server after a supported concurrent personal-preference update; routes only hold delivery.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { errorResponseSchema, personalTablePreferenceResponseSchema, projectColumnsResponseSchema, type ColumnChoice, type PersonalTablePreferenceDto, type TaskTableBuiltinColumn } from '@workloom/contracts';
import { apiCall, dailyFixture, gate } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { sizes, type Daily } from './support/next-ux.js';

const conflictTitle = 'Unable to save your table columns';
const conflictDescription = 'This data changed elsewhere. Load the latest version before saving again.';
const pendingCopy = 'Your column settings are still being saved.';
const conflictCopy = 'Your column changes were not saved because your settings changed elsewhere. Review them to reload and continue.';
const endpoint = (f: Daily) => `${f.prefix}/projects/${f.project.id}/table-preferences/me`;
async function head(f: Daily) { const r = await f.request.get(endpoint(f)); expect(r.status()).toBe(200); return personalTablePreferenceResponseSchema.parse(await r.json()).data; }
async function shared(f: Daily) { const r = await f.request.get(`${f.prefix}/projects/${f.project.id}/columns`); expect(r.status()).toBe(200); return projectColumnsResponseSchema.parse(await r.json()).data; }
const dialogFor = (page: Page) => page.getByRole('dialog', { name: 'My task columns', exact: true });
async function chooser(page: Page) { await page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ }).click(); const dialog = dialogFor(page); await expect(dialog.getByRole('checkbox').first()).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Use project defaults', exact: true })).toBeEnabled(); return dialog; }
function choice(dialog: Locator, name: string) { return dialog.getByRole('listitem').filter({ has: dialog.page().getByText(name, { exact: true }) }).getByRole('checkbox'); }
const saveButton = (dialog: Locator) => dialog.getByRole('button', { name: 'Save columns', exact: true });
async function close(dialog: Locator) { await dialog.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(dialog).toHaveCount(0); }
async function save(page: Page, dialog: Locator, f: Daily) { const done = page.waitForResponse(r => apiCall(r, 'PUT', endpoint(f))); await saveButton(dialog).click(); const r = await done; expect(r.status(), await r.text()).toBe(200); const result = personalTablePreferenceResponseSchema.parse(await r.json()).data; await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible(); return result; }
function stored(columns: ColumnChoice[] | null, key: TaskTableBuiltinColumn) { const rows = (columns ?? []).filter(item => item.column.kind === 'builtin' && item.column.key === key); if (rows.length !== 1 || !rows[0]) throw Error(`Exactly one stored ${key} entry is required.`); return rows[0].visible; }
function invert(columns: ColumnChoice[] | null, key: TaskTableBuiltinColumn): ColumnChoice[] { stored(columns, key); return (columns ?? []).map(item => item.column.kind === 'builtin' && item.column.key === key ? { ...item, visible: !item.visible } : item); }
const table = (page: Page) => page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Task', exact: true }) });
async function headerShown(page: Page, name: string, shown: boolean) { await expect(table(page).getByRole('columnheader', { name, exact: true })).toHaveCount(shown ? 1 : 0); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }

type Traffic = { method: string; path: string; key?: string; body: string | null };
/** Records every page write and every page read of the own preference head; fixture/API calls are not page traffic. */
function observe(page: Page, f: Daily) {
  const traffic: Traffic[] = [], errors: string[] = [];
  page.on('request', q => { const path = new URL(q.url()).pathname; if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method()) || path === endpoint(f)) traffic.push({ method: q.method(), path, key: q.headers()['idempotency-key'], body: q.postData() }); });
  page.on('pageerror', e => errors.push(e.message));
  return { traffic, errors, writes: () => traffic.filter(t => t.method !== 'GET'), reads: () => traffic.filter(t => t.method === 'GET' && t.path === endpoint(f)) };
}
/** A real first save from the actual UI state; no default visibility is assumed. */
async function baseline(page: Page, f: Daily) {
  const initial = await head(f); expect(initial).toMatchObject({ revision: 0, columns: null, membershipId: f.own.id });
  await page.goto(f.path); const dialog = await chooser(page);
  const due = await choice(dialog, 'Due date').isChecked(), tags = await choice(dialog, 'Tags').isChecked();
  await choice(dialog, 'Due date').setChecked(!due); expect(await head(f)).toEqual(initial);
  const saved = await save(page, dialog, f); expect(saved.revision).toBe(1); expect(stored(saved.columns, 'dueDate')).toBe(!due); expect(stored(saved.columns, 'tags')).toBe(tags);
  expect(await head(f)).toEqual(saved); return { dialog, due, tags, saved };
}
/** A supported concurrent own-preference update through the real API, inverting the stored Priority choice. */
async function concurrentUpdate(f: Daily, current: PersonalTablePreferenceDto) {
  const r = await f.request.put(endpoint(f), { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: current.revision, columns: invert(current.columns, 'priority') } });
  expect(r.status(), await r.text()).toBe(200); const next = personalTablePreferenceResponseSchema.parse(await r.json()).data;
  expect(next.revision).toBe(current.revision + 1); expect(await head(f)).toEqual(next); return next;
}

for (const [name, viewport] of sizes) test.describe(`Personal columns conflict recovery ${name}`, () => {
  test.use({ viewport });

  test('a real stale-revision 409 discards to a held current-head refresh that blocks edits and writes, then saves at the fresh revision', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Personal columns conflict discard'); const task = await f.createTask(`${f.token} columns conflict`); const team = await shared(f);
    const seen = observe(page, f);
    const { dialog, due, tags, saved: base } = await baseline(page, f);
    await choice(dialog, 'Tags').setChecked(!tags); await expect(choice(dialog, 'Tags')).toBeChecked({ checked: !tags });
    expect(seen.writes()).toHaveLength(1); expect(await head(f)).toEqual(base);
    const concurrent = await concurrentUpdate(f, base);
    await evidenceJson(info, '00-stale-draft.json', { viewport, due, tags, base, concurrent, writes: seen.writes() });

    const conflictResponse = page.waitForResponse(r => apiCall(r, 'PUT', endpoint(f))); await saveButton(dialog).click();
    const rejected = await conflictResponse; expect(rejected.status()).toBe(409);
    const serverError = errorResponseSchema.parse(await rejected.json()).error; expect(serverError.code).toBe('REVISION_CONFLICT');
    expect(JSON.parse(seen.writes()[1]?.body ?? 'null')).toEqual({ expectedRevision: base.revision, columns: invert(base.columns, 'tags') });
    const alert = dialog.getByRole('alert'); await expect(alert).toContainText(conflictTitle); await expect(alert).toContainText(conflictDescription); await expect(dialog).not.toContainText(serverError.message);
    await expect(saveButton(dialog)).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Reload and review', exact: true })).toBeEnabled();
    await expect(choice(dialog, 'Tags')).toBeChecked({ checked: !tags }); expect(await head(f)).toEqual(concurrent);

    // Hold only the post-discard current-head read; the request still reaches the real API after release.
    const refresh = gate(); let holdNextRead = false; const heldReads: string[] = [];
    await page.route(`**${endpoint(f)}`, async route => {
      if (route.request().method() === 'GET' && holdNextRead) { holdNextRead = false; heldReads.push(route.request().url()); await refresh.wait; }
      await route.continue();
    });
    try {
      const readsBefore = seen.reads().length; holdNextRead = true;
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect.poll(() => heldReads.length).toBe(1); expect(seen.reads()).toHaveLength(readsBefore + 1);
      await expect(dialog.getByText(conflictDescription)).toHaveCount(0);
      const boxes = dialog.getByRole('checkbox'), total = await boxes.count(); expect(total).toBeGreaterThan(1);
      for (let i = 0; i < total; i++) await expect(boxes.nth(i)).toBeDisabled();
      await expect(saveButton(dialog)).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Use project defaults', exact: true })).toBeDisabled();
      await expect(choice(dialog, 'Tags')).toBeChecked({ checked: tags });
      // The native disabled state above blocks the frozen controls; no further command is sent.
      expect(seen.writes()).toHaveLength(2); expect(await head(f)).toEqual(concurrent);
      const heldStatus = await dialog.getByRole('status').allTextContents();
      await evidenceJson(info, '01-held-refresh.json', { status: rejected.status(), code: serverError.code, heldReads, heldStatus, writes: seen.writes() });
      await info.attach(`held-refresh-${name}.png`, { body: await page.screenshot(), contentType: 'image/png' });

      const refreshed = page.waitForResponse(r => apiCall(r, 'GET', endpoint(f))); refresh.release();
      const current = await refreshed; expect(current.status()).toBe(200); expect(personalTablePreferenceResponseSchema.parse(await current.json()).data).toEqual(concurrent);
    } finally { refresh.release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }

    await expect(choice(dialog, 'Tags')).toBeEnabled(); await expect(dialog.getByRole('button', { name: 'Use project defaults', exact: true })).toBeEnabled();
    await expect(choice(dialog, 'Tags')).toBeChecked({ checked: tags }); await expect(choice(dialog, 'Due date')).toBeChecked({ checked: !due });
    await expect(choice(dialog, 'Priority')).toBeChecked({ checked: stored(concurrent.columns, 'priority') });
    await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toHaveCount(0); expect(seen.writes()).toHaveLength(2);

    await choice(dialog, 'Tags').setChecked(!tags); const fresh = await save(page, dialog, f);
    expect(JSON.parse(seen.writes()[2]?.body ?? 'null')).toEqual({ expectedRevision: concurrent.revision, columns: invert(concurrent.columns, 'tags') });
    expect(fresh).toMatchObject({ revision: concurrent.revision + 1, columns: invert(concurrent.columns, 'tags') }); expect(await head(f)).toEqual(fresh);
    await close(dialog);
    await headerShown(page, 'Tags', !tags); await headerShown(page, 'Due date', !due); await headerShown(page, 'Priority', stored(concurrent.columns, 'priority'));

    const writes = seen.writes(); expect(writes).toHaveLength(3); expect(writes.every(w => w.method === 'PUT' && w.path === endpoint(f))).toBe(true);
    expect(new Set(writes.map(w => w.key)).size).toBe(3); expect(writes.every(w => Boolean(w.key))).toBe(true);
    expect(await shared(f)).toEqual(team); expect(await f.task(task.id)).toEqual(task); expect(seen.errors).toEqual([]); await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`conflict-discard-${name}.png`) });
    await evidenceJson(info, '02-fresh-save.json', { input: 'Native Playwright mouse at stated viewport; no physical-touch or authentication claim', base, concurrent, fresh, writes, reads: seen.reads().length, errors: seen.errors });
  });

  test('a delayed real 409 delivered after Save, Close and Board keeps a safe closed error with explicit review in Graph and no automatic write', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Personal columns delayed conflict'); const task = await f.createTask(`${f.token} delayed conflict`); const team = await shared(f);
    const seen = observe(page, f);
    const { dialog, tags, saved: base } = await baseline(page, f);
    await choice(dialog, 'Tags').setChecked(!tags); expect(seen.writes()).toHaveLength(1);
    const concurrent = await concurrentUpdate(f, base);

    // The API answers 409 before the page does; only delivery to the page waits for the gate.
    const deliver = gate(); let produced: { status: number; body: string } | undefined;
    await page.route(`**${endpoint(f)}`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const response = await route.fetch(); produced = { status: response.status(), body: await response.text() };
      await deliver.wait; await route.fulfill({ response });
    });
    try {
      await saveButton(dialog).click(); await expect.poll(() => produced?.status).toBe(409);
      if (!produced) throw Error('The real server conflict is required.');
      const serverError = errorResponseSchema.parse(JSON.parse(produced.body)).error; expect(serverError.code).toBe('REVISION_CONFLICT');
      expect(await head(f)).toEqual(concurrent);
      await close(dialog);
      const pending = page.getByRole('status').filter({ hasText: pendingCopy }); await expect(pending).toBeVisible();
      await page.getByRole('button', { name: 'Board', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('board');
      await expect(page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ })).toHaveCount(0);
      await expect(pending.getByRole('button', { name: 'Resume column save', exact: true })).toBeVisible();
      const boardUrl = page.url(), writesBefore = seen.writes().length, readsBefore = seen.reads().length; expect(writesBefore).toBe(2);
      await evidenceJson(info, '00-held-conflict.json', { viewport, tags, base, concurrent, produced: { status: produced.status, code: serverError.code }, boardUrl, writes: seen.writes() });

      const delivered = page.waitForResponse(r => apiCall(r, 'PUT', endpoint(f))); deliver.release(); expect((await delivered).status()).toBe(409);
      const banner = page.getByRole('status').filter({ hasText: conflictCopy }); await expect(banner).toBeVisible();
      await expect(page.getByText(pendingCopy)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Resume column save', exact: true })).toHaveCount(0);
      await expect(banner.getByRole('button', { name: 'Review columns', exact: true })).toBeVisible();
      await expect(dialogFor(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeFocused();
      await expect(page.getByText(serverError.message)).toHaveCount(0); expect(page.url()).toBe(boardUrl);
      await info.attach(`board-closed-conflict-${name}.png`, { body: await page.screenshot(), contentType: 'image/png' });

      await page.getByRole('button', { name: 'Graph', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('graph');
      await expect(page.getByRole('region', { name: 'Project dependencies', exact: true })).toBeVisible();
      await expect(banner).toBeVisible(); await expect(page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ })).toHaveCount(0);
      const graphUrl = page.url();
      expect(seen.writes()).toHaveLength(writesBefore); expect(seen.reads()).toHaveLength(readsBefore); expect(await head(f)).toEqual(concurrent);

      await banner.getByRole('button', { name: 'Review columns', exact: true }).click();
      const review = dialogFor(page); await expect(review).toBeVisible();
      await expect(choice(review, 'Tags')).toBeChecked({ checked: !tags });
      const alert = review.getByRole('alert'); await expect(alert).toContainText(conflictTitle); await expect(alert).toContainText(conflictDescription); await expect(review).not.toContainText(serverError.message);
      await expect(saveButton(review)).toBeDisabled(); await expect(review.getByRole('button', { name: 'Reload and review', exact: true })).toBeEnabled();
      expect(page.url()).toBe(graphUrl); expect(seen.writes()).toHaveLength(writesBefore); expect(seen.reads()).toHaveLength(readsBefore);
      await info.attach(`graph-review-${name}.png`, { body: await page.screenshot(), contentType: 'image/png' });
      await close(review); await expect(banner).toBeVisible(); await expect(banner.getByRole('button', { name: 'Review columns', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe(null);
      await expect(page.getByRole('button', { name: 'Columns · unsaved', exact: true })).toBeVisible(); await expect(banner).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review columns', exact: true })).toHaveCount(0);
      expect(seen.writes()).toHaveLength(writesBefore); expect(seen.reads()).toHaveLength(readsBefore);
      expect(seen.writes().every(w => w.method === 'PUT' && w.path === endpoint(f))).toBe(true);
      expect(await head(f)).toEqual(concurrent); expect(await shared(f)).toEqual(team); expect(await f.task(task.id)).toEqual(task); expect(seen.errors).toEqual([]); await noOverflow(page);
      await evidenceJson(info, '01-closed-conflict-review.json', { input: 'Native Playwright mouse at stated viewport; no physical-touch or authentication claim', boardUrl, graphUrl, writes: seen.writes(), readsAfterDelivery: seen.reads().length - readsBefore, head: await head(f), errors: seen.errors });
    } finally { deliver.release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
  });
});
