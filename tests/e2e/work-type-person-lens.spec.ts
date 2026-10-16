// Local lens over a genuine immutable API report; no fake chart or source responses.
import { expect, test } from '@playwright/test';
import { workTypeReportRunResponseSchema } from '@workloom/contracts';
import { dailyFixture } from './support/daily-fixture.js';
import { recordedHoursFixture, sizes } from './support/next-ux.js';
for (const [name, viewport] of sizes) test.describe(`Saved work-type person lens ${name}`, () => {
  test.use({ viewport });
  test('team/person/active-zero/no-entry chart and table share pinned totals with no requests or source filtering', async ({ page, request, baseURL }, info) => {
    test.setTimeout(70_000); const f = await dailyFixture(request, baseURL, 'Person lens'); const r = await recordedHoursFixture(f);
    await page.goto(`${f.path}/week?period=${r.period.id}&view=work-types&typeRun=${r.run.id}`);
    const lens = page.getByRole('region', { name: 'Work-type distribution', exact: true }), select = lens.getByRole('combobox', { name: 'Show distribution for', exact: true });
    const sources = page.getByRole('region', { name: 'Breakdown sources', exact: true }); await expect(sources.getByRole('row')).toHaveCount(5);
    await expect(sources).toContainText('These source details cover all selected people in this saved report. The chart selection does not filter them.');
    const sourceText = await sources.innerText(); const calls: string[] = []; page.on('request', q => { if (new URL(q.url()).pathname.startsWith('/api/')) calls.push(`${q.method()} ${new URL(q.url()).pathname}`); });
    const table = lens.getByRole('table', { name: 'Share of recorded hours', exact: true });
    const scopes = [
      ['', 'All selected people', '5h', 4, [['Design', '1h', '20%'], ['Support', '3h', '60%'], ['Uncategorized', '1h', '20%']]],
      [f.own.id, f.own.displayName, '2h', 2, [['Design', '1h', '50%'], ['Uncategorized', '1h', '50%']]],
      [f.other.id, f.other.displayName, '3h', 1, [['Support', '3h', '100%']]],
    ] as const;
    for (const [id, label, hours, count, buckets] of scopes) {
      await select.selectOption(id); await expect(lens).toContainText(`Recorded hours · ${label}`); await expect(lens).toContainText(`Share denominator: ${hours} recorded · ${count} active ${count === 1 ? 'entry' : 'entries'}. Uncategorized hours are included.`);
      await expect(table.getByRole('row')).toHaveCount(buckets.length + 1);
      for (const [category, time, share] of buckets) { await expect(lens.getByRole('img', { name: `${category}: ${time}, ${share}`, exact: true })).toBeVisible(); await expect(table.getByRole('row').filter({ has: page.getByRole('cell', { name: category, exact: true }) }).getByRole('cell')).toHaveText([category, time, share]); }
      expect(await sources.innerText()).toBe(sourceText); expect(calls).toEqual([]);
    }
    await select.selectOption(r.zero.id); await expect(lens).toContainText('Share denominator: 0m recorded · 1 active entry.'); await expect(lens).toContainText('Percentages are undefined'); await expect(table.getByRole('row')).toHaveCount(2); await expect(table.getByRole('cell', { name: 'Share undefined', exact: true })).toBeVisible();
    await select.selectOption(r.empty.id); await expect(lens).toContainText('This selection has no active entries.'); await expect(lens).toContainText('No category totals are recorded for this selection.'); await expect(table.getByRole('row')).toHaveCount(1); expect(await sources.innerText()).toBe(sourceText); expect(calls).toEqual([]);
    await select.selectOption(''); await expect(page.getByRole('region', { name: 'Saved breakdown', exact: true })).toContainText('Saved report totals · all selected people');
    expect(workTypeReportRunResponseSchema.parse(await (await request.get(`${f.prefix}/work-type-report-runs/${r.run.id}`)).json()).data).toEqual(r.run);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await lens.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`person-lens-${name}.png`) }); await info.attach('immutable-lens.json', { body: JSON.stringify({ run: r.run, calls, reportWideSourcesUnchanged: true }), contentType: 'application/json' });
  });
});
