import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { manualPeriodWorkLogResponseSchema, planningPeriodResponseSchema, projectWorkCategoryBindingResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, workTypeReportRunResponseSchema } from '@workloom/contracts';
import type { dailyFixture } from './daily-fixture.js';
export const sizes = [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const;
export type Daily = Awaited<ReturnType<typeof dailyFixture>>;
export async function mutate<T>(f: Daily, method: 'PUT' | 'PATCH', path: string, data: unknown, schema: { parse(value: unknown): T }) {
  const r = await f.request.fetch(f.prefix + path, { method, headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data });
  expect(r.status(), await r.text()).toBe(200); return schema.parse(await r.json());
}
export async function futurePeriod(f: Daily) { return (await f.post('/periods', { projectId: f.project.id, name: 'Explicit QA week', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data; }
export async function stayWithDraft(page: Page) {
  const original = page.url(); await page.getByRole('link', { name: 'All projects', exact: true }).click();
  const guard = page.getByRole('dialog', { name: 'Leave this page?', exact: true }); await expect(guard).toContainText('You have an unsaved draft on this page.'); await expect(guard).not.toContainText('The server may have saved');
  await guard.getByRole('button', { name: 'Stay', exact: true }).click(); await expect(guard).toHaveCount(0); expect(page.url()).toBe(original);
}
export async function nativeStay(page: Page) {
  const url = page.url(), timeOrigin = await page.evaluate(() => performance.timeOrigin); const prompt = page.waitForEvent('dialog', { timeout: 5000 });
  const navigation = page.reload({ timeout: 5000, waitUntil: 'domcontentloaded' }).then(() => ({ outcome: 'completed' })).catch((error: unknown) => ({ outcome: 'not_completed', detail: error instanceof Error ? error.message : String(error) }));
  const dialog = await prompt; expect(dialog.type()).toBe('beforeunload'); await dialog.dismiss(); const settled = await navigation;
  expect(page.url()).toBe(url); expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin); return { type: dialog.type(), action: 'dismiss', navigation: settled, sameDocument: true };
}
/** All writes are real supported APIs in a new original-QA project. */
export async function recordedHoursFixture(f: Daily) {
  const people = f.members.filter(m => m.role !== 'viewer' && m.id !== f.own.id && m.id !== f.other.id); const zero = people[0], empty = people[1]; if (!zero || !empty) throw Error('Four existing synthetic non-viewer members required.');
  const field = (await f.post('/fields', { projectId: f.project.id, name: 'QA work type', type: 'single_select', options: [{ name: 'Design', color: '#6366f1' }, { name: 'Support', color: '#0d9488' }] }, taskFieldDefinitionResponseSchema)).data;
  const design = field.options[0], support = field.options[1]; if (!design || !support) throw Error('Two stored category options required.');
  const bindingHead = projectWorkCategoryBindingResponseSchema.parse(await (await f.request.get(`${f.prefix}/projects/${f.project.id}/work-category-binding`)).json()).data;
  await mutate(f, 'PATCH', `/projects/${f.project.id}/work-category-binding`, { expectedRevision: bindingHead.revision, fieldId: field.id }, projectWorkCategoryBindingResponseSchema);
  const a = await f.createTask(`${f.token} design`), b = await f.createTask(`${f.token} support`), u = await f.createTask(`${f.token} uncategorized`);
  for (const [task, option] of [[a, design], [b, support]] as const) await mutate(f, 'PUT', `/tasks/${task.id}/field-values/${field.id}`, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: option.id } }, taskFieldValueResponseSchema);
  const period = await futurePeriod(f);
  for (const [task, member, minutes] of [[a, f.own, 60], [u, f.own, 60], [b, f.other, 180], [a, zero, 0]] as const) await mutate(f, 'PUT', `/tasks/${task.id}/manual-period-work/${period.id}/${member.id}`, { expectedRevision: null, minutes, state: 'active' }, manualPeriodWorkLogResponseSchema);
  const run = (await f.post('/work-type-report-runs', { periodId: period.id, membershipIds: [f.own.id, f.other.id, zero.id, empty.id] }, workTypeReportRunResponseSchema)).data;
  expect(run).toMatchObject({ totalActualMinutes: 300, activeSourceCount: 4, categorizedMinutes: 240, uncategorizedMinutes: 60 }); expect(run.byPerson.find(p => p.membershipId === empty.id)).toMatchObject({ totalActualMinutes: 0, activeSourceCount: 0, byCategory: [] }); expect(run.byPerson.find(p => p.membershipId === zero.id)).toMatchObject({ totalActualMinutes: 0, activeSourceCount: 1 }); return { field, design, support, a, b, u, period, run, zero, empty };
}
