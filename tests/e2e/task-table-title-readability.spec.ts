import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { projectSchema, sectionResponseSchema, taskSchema } from '@workloom/contracts';
import { z } from 'zod';
import { dailyFixture } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { sizes } from './support/next-ux.js';

const fixtureSchema = z.object({
  stage: z.literal('complete'), version: z.literal(1), origin: z.string().url(),
  workspaceId: z.literal('5eed0000-0000-4000-8000-000000000201'),
  project: projectSchema, chain: z.array(taskSchema).length(9), short: taskSchema,
  realistic: taskSchema, unbroken: taskSchema,
});
type Fixture = z.infer<typeof fixtureSchema>;
let prepared: Promise<Fixture> | undefined;

/** One additive QA fixture is reused read-only at both sizes and across RED/GREEN runs. */
function titleFixture(request: APIRequestContext, baseURL: string | undefined) {
  prepared ??= prepareFixture(request, baseURL);
  return prepared;
}
async function prepareFixture(request: APIRequestContext, baseURL: string | undefined): Promise<Fixture> {
  if (!baseURL) throw Error('Live browser origin is required.');
  const key = process.env.WORKLOOM_TITLE_FIXTURE_KEY ?? 'cycle20261016-title-v1';
  if (!/^[A-Za-z0-9-]{1,80}$/.test(key)) throw Error('Explicit safe fixture key required.');
  const manifest = resolve('.local/qa', `task-title-${key}.json`);
  const origin = new URL(baseURL).origin;
  let previous: string | undefined;
  try { previous = await readFile(manifest, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous !== undefined) {
    const value = fixtureSchema.parse(JSON.parse(previous));
    if (value.origin !== origin) throw Error('Fixture origin changed; review its manifest.');
    return value;
  }
  await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
  async function save(value: unknown) {
    const temporary = `${manifest}.${randomUUID()}.pending`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, manifest);
  }
  // An interrupted fixture refuses silent reseeding; its starting manifest remains for review.
  await save({ stage: 'starting', origin, version: 1, startedAtUtc: new Date().toISOString() });
  const f = await dailyFixture(request, baseURL, 'Readable task titles');
  await save({ stage: 'creating-tasks', origin, version: 1, projectId: f.project.id });
  const second = (await f.post(`/projects/${f.project.id}/sections`,
    { name: 'Release follow-up', position: 1 }, sectionResponseSchema)).data;
  const names = [
    'Prepare the launch checklist',
    'Review the mobile experience',
    'Run the weekly workflow checks',
    'Validate keyboard navigation in the task workspace before the next team review',
    'Confirm the team working agreement',
    'Collect the first team feedback',
    'Review adoption signals',
    'Write the quick-start guide',
    'Review the mobile experience after resolving the keyboard navigation findings',
  ];
  const chain: Fixture['chain'] = [];
  for (const [depth, title] of names.entries()) {
    const parent = chain.at(-1);
    chain.push(await f.createTask(title, {
      position: depth, sectionId: depth === 3 || depth === 8 ? second.id : f.section.id,
      ...(parent ? { parentTaskId: parent.id } : { estimateMinutes: 180 }),
    }));
  }
  const short = await f.createTask('Check links', { position: 20, estimateMinutes: 0 });
  const realistic = await f.createTask('Review the mobile experience and document the remaining launch accessibility findings',
    { position: 21, estimateMinutes: 60 });
  const unbroken = await f.createTask(`AccessibilityReview${'Checklist'.repeat(12)}`,
    { position: 22, estimateMinutes: 0 });
  const value = fixtureSchema.parse({ stage: 'complete', version: 1, origin,
    workspaceId: f.workspace.id, project: f.project, chain, short, realistic, unbroken });
  await save(value);
  return value;
}

for (const [size, viewport] of sizes) test.describe(`Readable table titles ${size}`, () => {
  test.use({ viewport });
  test('full titles remain readable at deep hierarchy levels without overlapping native controls', async ({ page, request, baseURL }, info) => {
    test.setTimeout(65_000);
    const f = await titleFixture(request, baseURL);
    const tasks = [...f.chain, f.short, f.realistic, f.unbroken];
    const leaf = f.chain[8], root = f.chain[0];
    if (!leaf || !root) throw Error('Nine stored hierarchy levels required.');
    const writes: { method: string; path: string }[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
        writes.push({ method: request.method(), path: url.pathname });
    });
    await page.goto(`/w/${f.workspaceId}/projects/${f.project.id}`);
    const table = page.getByRole('table', { name: `Tasks in “${f.project.name}”`, exact: true });
    await expect(table.getByRole('checkbox')).toHaveCount(tasks.length);
    const button = (title: string) => table.getByRole('button', { name: title, exact: true });
    await button(leaf.title).focus();
    await button(leaf.title).press('Enter');
    const drawer = page.getByRole('dialog', { name: leaf.title, exact: true });
    await drawer.getByLabel('Description', { exact: true }).fill('Unsent deep task draft');
    await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(drawer).toHaveCount(0);
    const leafRow = button(leaf.title).locator('xpath=ancestor::tr');
    await expect(leafRow.getByText('Draft', { exact: true })).toBeVisible();
    await expect(leafRow.getByText('Section: Release follow-up', { exact: true })).toBeVisible();
    await table.getByRole('checkbox', { name: `Select for graph: ${leaf.title}`, exact: true }).check();
    await expect(table.getByRole('checkbox', { name: `Select for graph: ${leaf.title}`, exact: true })).toBeChecked();

    const geometry = [];
    for (const task of tasks) {
      const title = button(task.title);
      await title.locator('xpath=ancestor::tr').scrollIntoViewIfNeeded();
      geometry.push(await title.evaluate(element => {
        const row = element.closest('tr'), cell = element.closest('td');
        if (!row || !cell) throw Error('Task title row and cell required.');
        const rect = element.getBoundingClientRect(), bounds = cell.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const overlaps = [...cell.querySelectorAll('button, input')].filter(other => other !== element)
          .map(other => other.getBoundingClientRect())
          .filter(other => other.width > 0 && other.height > 0 && rect.left < other.right - 0.5 &&
            rect.right > other.left + 0.5 && rect.top < other.bottom - 0.5 && rect.bottom > other.top + 0.5).length;
        return {
          title: element.textContent, titleWidth: rect.width, titleHeight: rect.height,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
          rowHeight: row.getBoundingClientRect().height, cellWidth: bounds.width, overlaps,
          ranges: [...range.getClientRects()].map(line => ({ left: line.left - rect.left,
            right: line.right - rect.left, top: line.top - rect.top, bottom: line.bottom - rect.top })),
          globalOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      }));
    }
    await leafRow.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
    await page.screenshot({ path: info.outputPath(`task-titles-${size}.png`), fullPage: true });
    await evidenceJson(info, 'title-geometry.json', { fixtureProjectId: f.project.id,
      depths: f.chain.map((task, depth) => ({ id: task.id, depth, title: task.title })), geometry, writes,
      fixtureReusedAcrossViewports: true, maximumStoredDepth: 8, physicalImeTested: false });

    for (const measured of geometry) {
      expect.soft(measured.titleWidth, `${measured.title}: positive title width`).toBeGreaterThan(0);
      expect.soft(measured.scrollWidth, `${measured.title}: no horizontal clipping`).toBeLessThanOrEqual(measured.clientWidth + 1);
      expect.soft(measured.scrollHeight, `${measured.title}: no vertical clipping`).toBeLessThanOrEqual(measured.clientHeight + 1);
      expect.soft(measured.overlaps, `${measured.title}: controls do not overlap`).toBe(0);
      expect.soft(measured.ranges.every(line => line.left >= -1 && line.right <= measured.titleWidth + 1 &&
        line.top >= -1 && line.bottom <= measured.titleHeight + 1), `${measured.title}: every text range is visible`).toBe(true);
      expect.soft(measured.globalOverflow, `${measured.title}: horizontal scrolling stays local`).toBeLessThanOrEqual(0);
    }
    const rename = table.getByRole('button', { name: `Rename ${root.title}`, exact: true });
    await rename.focus();
    await rename.press('Enter');
    const editor = page.getByRole('form', { name: `Edit ${root.title} in the task table`, exact: true });
    await expect(editor.getByLabel('Task name', { exact: true })).toBeFocused();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(rename).toBeFocused();
    const short = geometry.find(row => row.title === f.short.title);
    expect(short?.rowHeight, 'short plain rows remain compact').toBeLessThanOrEqual(52);
    expect(writes).toEqual([]);
  });
});
