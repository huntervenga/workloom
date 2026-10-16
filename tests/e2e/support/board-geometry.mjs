// Coordinator GET-only artifact probe, run ONLY after the compiled-window GO.
// Usage: node tests/e2e/support/board-geometry.mjs <fresh-private-output-dir> <expected-entry-sha256>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { writePrivateJson } from '../../../scripts/private-json.mjs';
const [directory, expected] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{64}$/.test(expected ?? '') || process.argv.length !== 4) throw Error('Fresh evidence directory and exact compiled entry hash required.');
const output = resolve(directory); if (existsSync(output)) throw Error('Refuse to overwrite evidence.'); mkdirSync(output, { recursive: true, mode: 0o700 });
const origin = 'http://127.0.0.1:4310', path = '/w/31800692-b5ab-4c59-87c9-118d9ea8eac9/projects/9266f142-b72a-40b8-bb86-350d6df7c209?view=board';
const evidence = { startedAt: new Date().toISOString(), origin, path, before634: { 390: { firstCardY: 334, global: 0 }, 1440: { firstCardY: 342, global: 0 } }, writes: [], errors: [], failures: [], frames: [] };
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: width < 600 ? 844 : 1000 } });
    await context.route('**/*', route => { if (['GET','HEAD','OPTIONS'].includes(route.request().method())) return route.continue(); evidence.writes.push({ method: route.request().method(), url: route.request().url() }); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror', e => evidence.errors.push(e.message)); page.on('response', r => { if (r.status() >= 400) evidence.failures.push({ url: r.url(), status: r.status() }); });
    await page.goto(path); const entry = await page.locator('script[type=module][src]').getAttribute('src'); if (!entry) throw Error('Missing entry.');
    const response = await context.request.get(entry); expect(response.status()).toBe(200); expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(expected);
    const lanes = page.getByRole('region', { name: 'Task status lanes', exact: true }); await expect(lanes.getByRole('listitem')).toHaveCount(12); await expect(page.getByText('12 loaded tasks in this view.', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveCount(0); await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveCount(0);
    const geometry = await lanes.evaluate(e => { const cards = [...e.querySelectorAll('li')]; return { viewport: globalThis.innerWidth, global: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth, client: e.clientWidth, content: e.scrollWidth, position: globalThis.getComputedStyle(e).position, firstCardY: cards[0]?.getBoundingClientRect().y ?? null, cardHeights: cards.map(c => c.getBoundingClientRect().height), lanes: [...e.querySelectorAll(':scope > div > section')].map(l => ({ title: l.querySelector('h3')?.textContent, cards: l.querySelectorAll('li').length, dueLabels: l.querySelectorAll('dt.sr-only').length })) }; });
    expect(geometry.global).toBeLessThanOrEqual(0); expect(geometry.position).toBe('relative'); expect(geometry.lanes).toHaveLength(4); expect(geometry.lanes[2]).toMatchObject({ cards: 2, dueLabels: 2 });
    await page.screenshot({ path: resolve(output, `board-${width}.png`) }); await lanes.evaluate(e => { e.scrollLeft = e.scrollWidth; }); const last = await lanes.evaluate(e => ({ scrollLeft: e.scrollLeft, global: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth })); expect(last.global).toBeLessThanOrEqual(0); expect(last.scrollLeft).toBeGreaterThan(0);
    await page.screenshot({ path: resolve(output, `board-${width}-last-lanes.png`) }); evidence.frames.push({ width, entry, ...geometry, last }); await context.close();
  }
  expect(evidence.writes).toEqual([]); expect(evidence.errors).toEqual([]); expect(evidence.failures).toEqual([]); evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error.message; process.exitCode = 1; }
finally { await browser.close(); evidence.finishedAt = new Date().toISOString(); writePrivateJson(resolve(output, 'audit.json'), evidence); }
