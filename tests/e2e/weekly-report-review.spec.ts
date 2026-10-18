// PRIVATE QA ONLY: real Chrome, full API, fake shared Auth provider and the private PostgreSQL child.
// Every report figure is a manually specified literal oracle, never derived from the UI or by summing server rows.
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  weeklyPlanFactReportRunResponseSchema,
  weeklyPlanFactRowListResponseSchema,
  workTypeReportRunResponseSchema,
  type MembershipDto,
  type WeeklyPlanFactReportRunDto,
  type WeeklyPlanFactRowDto,
  type WorkTypeReportRunDto,
} from '@workloom/contracts';
import { startFakeSharedAuth, type FakeSharedAuth } from './support/fake-shared-auth.js';
import {
  correctTaskA,
  createReportDataset,
  REPORT_APP,
  REPORT_MEMBER_NAMES,
  reportRead,
  signInReportOwner,
  type ReportDataset,
  type ReportWorkspace,
} from './support/weekly-report-private-fixture.js';

const AUTH_PORT = 49319;
const PERIOD_TIMEZONE = 'Asia/Nicosia';
const COMPARISON_CAPTION =
  'Saved baseline, added and unplanned hours for every person in this report, sorted by name';
const [BLAIR, CASEY, DEVON, ELLIS] = REPORT_MEMBER_NAMES;

const VARIANTS = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const;

// Fixed weekly oracle: A 120/150, B 60/0, C 90/missing, D unknown/45, E added 20 + unplanned 10.
const WEEKLY_ORIGINAL_SUMMARY = {
  knownPlannedMinutes: 270,
  actualMinutes: 195,
  baselineCompleteness: { knownItemCount: 3, totalItemCount: 4 },
  factCoverage: { recordedItemCount: 3, totalItemCount: 4 },
  totalVarianceMinutes: null,
  totalVariancePercent: null,
  addedActualMinutes: 20,
  unplannedActualMinutes: 10,
  totalActualMinutes: 225,
} as const;

// After the explicit A 150 -> 180 correction, a new current run only.
const WEEKLY_CORRECTED_SUMMARY = {
  ...WEEKLY_ORIGINAL_SUMMARY,
  actualMinutes: 225,
  totalActualMinutes: 255,
} as const;

const WORK_TYPE_ORIGINAL = { total: 225, categorized: 195, uncategorized: 30, design: 150, maintenance: 45 } as const;
const WORK_TYPE_CORRECTED = { total: 255, categorized: 225, uncategorized: 30, design: 180, maintenance: 45 } as const;

let provider: FakeSharedAuth | undefined;

test.describe('weekly report review on private shared Auth', () => {
  test.describe.configure({ mode: 'serial' });
  // Host zone deliberately differs from the period zone.
  test.use({ timezoneId: 'America/Los_Angeles' });

  test.beforeAll(async () => {
    if (process.env.WORKLOOM_QA_BASE_URL !== REPORT_APP) {
      throw new Error('WORKLOOM_QA_BASE_URL must be exactly the private QA origin; no fallback.');
    }
    provider = await startFakeSharedAuth({ port: AUTH_PORT, appOrigin: REPORT_APP });
  });

  test.afterAll(async () => {
    await provider?.close();
    provider = undefined;
  });

  for (const variant of VARIANTS) {
    test(`saved weekly and work-type reports stay pinned and reviewable (${variant.name})`, async (
      { page, context },
      testInfo,
    ) => {
      test.setTimeout(120_000);
      await page.setViewportSize(variant.viewport);
      if (!provider) throw new Error('Fake shared Auth provider is not running.');
      await runJourney(page, context, testInfo, provider, variant.name);
    });
  }
});

async function runJourney(
  page: Page,
  context: BrowserContext,
  testInfo: TestInfo,
  auth: FakeSharedAuth,
  variant: (typeof VARIANTS)[number]['name'],
): Promise<void> {
  const browserMutations = trackBrowserMutations(page);
  const f = await signInReportOwner(page, auth);
  const workspaceMutations = (): string[] => browserMutations.filter((entry) => entry.includes(f.prefix));
  const data = await createReportDataset(f);
  const allFive = [f.owner.id, f.blair.id, f.casey.id, f.devon.id, f.ellis.id];
  // The provider names every identity the same; the display order is by saved name only.
  const namesInOrder = [f.owner.displayName, BLAIR, CASEY, DEVON, ELLIS].sort((a, b) => a.localeCompare(b));

  // ---- Weekly report: one explicit click creates the pinned run. ----
  await page.goto(weeklyUrl(f.workspaceId, data.projectId, data.periodId, f.owner.id, 'report'));
  const weeklyNav = page.getByRole('navigation', { name: 'Weekly view' });
  await expect(weeklyNav.getByRole('button', { name: 'Report' })).toBeVisible();
  // Desktop reviews in light, mobile in dark, chosen only through the real theme toggle.
  const theme = variant === 'mobile' ? 'dark' : 'light';
  await chooseTheme(page, theme);
  await expect(page.getByRole('combobox', { name: 'Time entry for' })).toHaveCount(0);
  expectWorker(page, f.owner.id);
  expect(workspaceMutations()).toEqual([]);

  const first = await clickAndCapturePost(
    page,
    page.getByRole('button', { name: 'Calculate current report' }),
    `${f.prefix}/report-runs`,
  );
  expect(first.body).toEqual({ baselineId: data.baselineId, knownEstimatesOnly: false, membershipIds: [] });
  expect(first.idempotencyKey.length).toBeGreaterThan(0);
  const oldRunId = weeklyPlanFactReportRunResponseSchema.parse(first.response).data.id;

  const oldRunParsed = await reportRead(page, `${f.prefix}/report-runs/${oldRunId}`, weeklyPlanFactReportRunResponseSchema);
  const oldRun = oldRunParsed.data;
  expect(oldRun.baselineId).toBe(data.baselineId);
  expect(oldRun.knownEstimatesOnly).toBe(false);
  expect(oldRun.summary).toMatchObject(WEEKLY_ORIGINAL_SUMMARY);
  expectWeeklyPeople(oldRun, f, 'original');
  const oldRowsParsed = await reportRead(
    page,
    `${f.prefix}/report-runs/${oldRunId}/rows?limit=100`,
    weeklyPlanFactRowListResponseSchema,
  );
  expect(oldRowsParsed.data).toHaveLength(6);
  expect(rowHasSavedLog(oldRowsParsed.data, data.tasks.a.id, data.logs.a.revisionId, 150)).toBe(true);
  // Extra rows: U was in the frozen census without a commitment; E was created and committed after freeze.
  const savedExtraU = oldRowsParsed.data.find(
    (row) => row.workPackageId === data.tasks.u.workPackageId && row.membershipId === f.ellis.id,
  );
  if (savedExtraU === undefined) throw new Error('Saved unplanned row for task U is missing.');
  expect(savedExtraU).toMatchObject({
    scope: 'unplanned',
    actualMinutes: 10,
    plannedMinutes: null,
    commitmentId: null,
    factRecorded: true,
  });
  expect(savedExtraU.taskIds).toContain(data.tasks.u.id);
  expect(rowHasSavedLog([savedExtraU], data.tasks.u.id, data.logs.u.revisionId, 10)).toBe(true);
  const savedExtraE = oldRowsParsed.data.find(
    (row) => row.workPackageId === data.tasks.e.workPackageId && row.membershipId === f.ellis.id,
  );
  if (savedExtraE === undefined) throw new Error('Saved added-scope row for task E is missing.');
  expect(savedExtraE).toMatchObject({
    scope: 'added_scope',
    actualMinutes: 20,
    plannedMinutes: 30,
    factRecorded: true,
  });
  expect(savedExtraE.taskIds).toContain(data.tasks.e.id);
  expect(rowHasSavedLog([savedExtraE], data.tasks.e.id, data.logs.e.revisionId, 20)).toBe(true);

  await expect(page).toHaveURL((url) => url.searchParams.get('run') === oldRunId);
  expectWorker(page, f.owner.id);
  const pinnedReportUrl = page.url();

  const savedReport = page.getByRole('region', { name: 'Saved report' });
  await expectSavedIdentity(savedReport, oldRun, namesInOrder);
  // Each visible metric is bound to its semantic label, independently of the person table.
  for (const [label, value] of [
    ['Known planned hours', '4h 30m'], ['Actual hours for baseline work', '3h 15m'],
    ['Added work', '20m'], ['Unplanned work', '10m'], ['All recorded hours', '3h 45m'],
  ] as const) await expect(metricValue(savedReport, label)).toHaveText(value);
  await expect(savedReport).toContainText('Insufficient data');
  const comparison = page.getByRole('table', { name: COMPARISON_CAPTION });
  await expect(savedReport.getByRole('table', { name: COMPARISON_CAPTION })).toHaveCount(0);
  await expectComparisonRows(comparison, namesInOrder, f.owner.displayName);
  const chart = page.getByRole('figure', { name: 'Baseline vs actual by person', exact: true });
  await expect(chart.getByRole('img')).toHaveCount(8); // Four original-baseline people; Ellis remains in the full table.
  await expect(chart.getByRole('img', { name: `${f.owner.displayName}, actual: 2h 30m`, exact: true })).toBeVisible();
  await expect(chart.getByRole('img', { name: `${BLAIR}, actual: 0m`, exact: true })).toBeVisible();
  await expect(chart.getByRole('img', { name: `${CASEY} · incomplete data, actual: Not recorded`, exact: true })).toBeVisible();
  await expect(chart.getByRole('img', { name: `${DEVON} · incomplete data, plan: Not set`, exact: true })).toBeVisible();
  await expect(page.getByText(/^Bars compare known planned hours with recorded actual hours/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Time entry for' })).toHaveCount(0);

  if (variant === 'mobile') {
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await scrollTableHorizontally(comparison);
    await comparison.locator('tbody tr').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('mobile-comparison.png') });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await savedReport.scrollIntoViewIfNeeded();
    await expect(savedReport.locator('dl[aria-label="Saved report identity"]')).toBeVisible();
    await expect(peopleEntry(savedReport).getByText('5 people in saved report', { exact: true })).toBeVisible();
    await expect(savedReport.locator('summary').filter({ hasText: /^Show saved names$/ })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath(`${variant}-report-old.png`) });

  // ---- Explicit clipboard copy: no network mutation, focus kept, no storage leak. ----
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: REPORT_APP });
  expect(workspaceMutations()).toHaveLength(1);
  const copyButton = savedReport.getByRole('button', { name: 'Copy summary' });
  await copyButton.click();
  await expect(page.getByText('Summary copied to the clipboard.')).toBeVisible();
  await expect(copyButton).toBeFocused();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // Boolean assertions only, so the synthetic copy text is never echoed into logs.
  const fragments: [string, string][] = [
    ['known planned', '4h 30m'],
    ['original actual', '3h 15m'],
    ['total recorded', '3h 45m'],
    ['period timezone', PERIOD_TIMEZONE],
    ['missing actual', 'Not recorded'],
    ['zero actual', '0m'],
    ...namesInOrder.map((name, index): [string, string] => [`person ${index + 1}`, name]),
  ];
  for (const [label, fragment] of fragments) {
    expect(copied.includes(fragment), `copied summary includes ${label}`).toBe(true);
  }
  // Complete per-person lines bind each state to its own person; the difference sign is U+2212.
  const copiedLines = copied.split('\n');
  const personLines: [string, string][] = [
    ['active-zero person line', `- ${BLAIR}: plan 1h; actual 0m; difference −1h; added 0m; unplanned 0m; all recorded 0m`],
    ['missing-actual person line', `- ${CASEY}: plan 1h 30m; actual Not recorded; difference Insufficient data; added 0m; unplanned 0m; all recorded 0m`],
    ['unknown-plan person line', `- ${DEVON}: plan Not known; actual 45m; difference Insufficient data; added 0m; unplanned 0m; all recorded 45m`],
    ['added-and-unplanned-only person line', `- ${ELLIS}: plan No baseline work; actual No baseline work; difference Difference unavailable; added 20m; unplanned 10m; all recorded 30m`],
  ];
  for (const [label, line] of personLines) {
    expect(copiedLines.includes(line), `copied summary has the ${label}`).toBe(true);
  }
  expect(await storageContains(page, copied), 'copied summary absent from web storage').toBe(false);
  expect(workspaceMutations()).toHaveLength(1);

  // ---- Work types: explicit five-person breakdown. ----
  await weeklyNav.getByRole('button', { name: 'Work types' }).click();
  await expect(page.getByRole('combobox', { name: 'Time entry for' })).toHaveCount(0);
  expectWorker(page, f.owner.id);
  await expect(page.getByRole('region', { name: 'Saved breakdown' })).toHaveCount(0);
  const settings = page.getByRole('region', { name: 'New report settings' });
  await expect(settings).toBeVisible();
  for (const name of namesInOrder) {
    await settings.getByRole('checkbox', { name }).check();
  }
  const breakdown = await clickAndCapturePost(
    page,
    settings.getByRole('button', { name: 'Calculate hours breakdown' }),
    `${f.prefix}/work-type-report-runs`,
  );
  const breakdownBody = asRecord(breakdown.body);
  expect(breakdownBody.periodId).toBe(data.periodId);
  expect(sortedStrings(breakdownBody.membershipIds)).toEqual([...allFive].sort());
  expect(breakdown.idempotencyKey.length).toBeGreaterThan(0);
  const oldTypeRunId = workTypeReportRunResponseSchema.parse(breakdown.response).data.id;
  const oldTypeRunParsed = await reportRead(
    page,
    `${f.prefix}/work-type-report-runs/${oldTypeRunId}`,
    workTypeReportRunResponseSchema,
  );
  const oldTypeRun = oldTypeRunParsed.data;
  expect(oldTypeRun.periodId).toBe(data.periodId);
  expect([...oldTypeRun.membershipIds].sort()).toEqual([...allFive].sort());
  expectWorkTypeTotals(oldTypeRun, data, WORK_TYPE_ORIGINAL);
  expect(oldTypeRun.activeSourceCount).toBe(5);
  expectShare(oldTypeRun, data.designId, (150 / 225) * 100);
  expectShare(oldTypeRun, data.maintenanceId, 20);
  expectShare(oldTypeRun, null, (30 / 225) * 100);
  expectWorkTypePeople(oldTypeRun, f);
  await expect(page).toHaveURL((url) => url.searchParams.get('typeRun') === oldTypeRunId);
  expectWorker(page, f.owner.id);

  const savedBreakdown = page.getByRole('region', { name: 'Saved breakdown' });
  await expect(peopleEntry(savedBreakdown).getByText('5 people in saved report', { exact: true })).toBeVisible();
  await expect(metricValue(savedBreakdown, 'Total recorded')).toHaveText('3h 45m');
  await expect(metricValue(savedBreakdown, 'Categorized')).toHaveText('3h 15m');
  await expect(metricValue(savedBreakdown, 'Uncategorized')).toHaveText('30m');
  const distribution = page.getByRole('region', { name: 'Work-type distribution' });
  await expect(distribution.getByRole('table', { name: 'Share of recorded hours' })).toBeVisible();
  await expect(distribution).toContainText('66.7%');
  await expect(distribution).toContainText('20%');
  await expect(distribution).toContainText('13.3%');
  // Blair's explicit active zero is one entry; Casey has no active source at all.
  await expect(page.getByText(personSummary(BLAIR, 1))).toBeVisible();
  await page.getByText(personSummary(CASEY, 0)).click();
  await expect(page.getByText('This person has no active entries.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`${variant}-worktypes.png`) });
  const pinnedBreakdownUrl = page.url();
  expect(workspaceMutations()).toHaveLength(2);

  // ---- Explicit server correction A 150 -> 180; saved runs must not move. ----
  const corrected = await correctTaskA(f, data);

  await page.goto(pinnedReportUrl);
  await expect(savedReport).toBeVisible();
  await expectTheme(page, theme);
  await expect(metricWithValue(savedReport, '3h 45m')).toBeVisible();
  await expect(savedReport).not.toContainText('4h 15m');
  await expect(rowFor(comparison, f.owner.displayName)).toContainText('2h 30m');
  expectWorker(page, f.owner.id);
  expectSameSavedEnvelope(
    await reportRead(page, `${f.prefix}/report-runs/${oldRunId}`, weeklyPlanFactReportRunResponseSchema),
    oldRunParsed,
  );
  expectSameSavedEnvelope(
    await reportRead(page, `${f.prefix}/report-runs/${oldRunId}/rows?limit=100`, weeklyPlanFactRowListResponseSchema),
    oldRowsParsed,
  );
  expectSameSavedEnvelope(
    await reportRead(page, `${f.prefix}/work-type-report-runs/${oldTypeRunId}`, workTypeReportRunResponseSchema),
    oldTypeRunParsed,
  );
  expect(workspaceMutations()).toHaveLength(2);

  // ---- A new current weekly run reflects the correction under a new pin. ----
  const second = await clickAndCapturePost(
    page,
    page.getByRole('button', { name: 'Calculate current report' }),
    `${f.prefix}/report-runs`,
  );
  expect(second.body).toEqual({ baselineId: data.baselineId, knownEstimatesOnly: false, membershipIds: [] });
  const newRunId = weeklyPlanFactReportRunResponseSchema.parse(second.response).data.id;
  expect(newRunId).not.toBe(oldRunId);
  const newRun = (await reportRead(page, `${f.prefix}/report-runs/${newRunId}`, weeklyPlanFactReportRunResponseSchema))
    .data;
  expect(newRun.summary).toMatchObject(WEEKLY_CORRECTED_SUMMARY);
  expect(newRun.workLogRevisionIds).toContain(corrected.revisionId);
  expect(newRun.workLogRevisionIds).not.toContain(data.logs.a.revisionId);
  expect(oldRun.workLogRevisionIds).toContain(data.logs.a.revisionId);
  expect(oldRun.workLogRevisionIds).not.toContain(corrected.revisionId);
  expectWeeklyPeople(newRun, f, 'corrected');
  const newRows = (
    await reportRead(page, `${f.prefix}/report-runs/${newRunId}/rows?limit=100`, weeklyPlanFactRowListResponseSchema)
  ).data;
  expect(newRows).toHaveLength(6);
  expect(rowHasSavedLog(newRows, data.tasks.a.id, corrected.revisionId, 180)).toBe(true);
  expect(rowHasSavedLog(newRows, data.tasks.a.id, data.logs.a.revisionId, 150)).toBe(false);
  expect(rowHasSavedLog(oldRowsParsed.data, data.tasks.a.id, data.logs.a.revisionId, 150)).toBe(true);
  await expect(page).toHaveURL((url) => url.searchParams.get('run') === newRunId);
  await expect(metricWithValue(savedReport, '4h 15m')).toBeVisible();
  await expect(rowFor(comparison, f.owner.displayName)).toContainText('3h');
  expectWorker(page, f.owner.id);

  // ---- The old breakdown pin keeps original figures; the current breakdown is a new run. ----
  await page.goto(pinnedBreakdownUrl);
  await expect(metricValue(savedBreakdown, 'Total recorded')).toHaveText('3h 45m');
  await expect(metricValue(savedBreakdown, 'Categorized')).toHaveText('3h 15m');
  await expectTheme(page, theme);
  expectWorker(page, f.owner.id);
  expect(workspaceMutations()).toHaveLength(3);
  const current = await clickAndCapturePost(
    page,
    page.getByRole('button', { name: 'Calculate current breakdown' }),
    `${f.prefix}/work-type-report-runs`,
  );
  expect(current.body).toEqual({ periodId: data.periodId, membershipIds: [] });
  expect(current.idempotencyKey.length).toBeGreaterThan(0);
  const newTypeRunId = workTypeReportRunResponseSchema.parse(current.response).data.id;
  expect(newTypeRunId).not.toBe(oldTypeRunId);
  const newTypeRun = (
    await reportRead(page, `${f.prefix}/work-type-report-runs/${newTypeRunId}`, workTypeReportRunResponseSchema)
  ).data;
  // Default scope contains the four saved-source identities; Casey has no source and is excluded.
  expect([...newTypeRun.membershipIds].sort()).toEqual([f.owner.id, f.blair.id, f.devon.id, f.ellis.id].sort());
  expect(newTypeRun.byPerson).toHaveLength(4);
  expect(newTypeRun.byPerson.some(person => person.membershipId === f.casey.id)).toBe(false);
  expectWorkTypeTotals(newTypeRun, data, WORK_TYPE_CORRECTED);
  await expect(page).toHaveURL((url) => url.searchParams.get('typeRun') === newTypeRunId);
  await expect(metricValue(savedBreakdown, 'Total recorded')).toHaveText('4h 15m');
  await expect(metricValue(savedBreakdown, 'Categorized')).toHaveText('3h 45m');
  await expect(metricValue(savedBreakdown, 'Uncategorized')).toHaveText('30m');
  await expect(peopleEntry(savedBreakdown).getByText('4 people in saved report', { exact: true })).toBeVisible();
  expectSameSavedEnvelope(
    await reportRead(page, `${f.prefix}/work-type-report-runs/${oldTypeRunId}`, workTypeReportRunResponseSchema),
    oldTypeRunParsed,
  );
  expectWorker(page, f.owner.id);

  // Only the four explicit calculations wrote from the browser: none on view, reload, tab change or copy.
  expect(workspaceMutations()).toEqual([
    `POST ${f.prefix}/report-runs`,
    `POST ${f.prefix}/work-type-report-runs`,
    `POST ${f.prefix}/report-runs`,
    `POST ${f.prefix}/work-type-report-runs`,
  ]);
}

// ---------- Server oracles ----------

function expectWeeklyPeople(run: WeeklyPlanFactReportRunDto, f: ReportWorkspace, phase: 'original' | 'corrected'): void {
  expect(run.byPerson).toHaveLength(5);
  const person = (member: MembershipDto) => {
    const found = run.byPerson.find((entry) => entry.membershipId === member.id);
    if (!found) throw new Error(`Saved person ${member.displayName} is missing.`);
    expect(found.memberName).toBe(member.displayName);
    return found.summary;
  };

  const a = person(f.owner);
  expect(a).toMatchObject({
    knownPlannedMinutes: 120,
    actualMinutes: phase === 'original' ? 150 : 180,
    totalVarianceMinutes: phase === 'original' ? 30 : 60,
    factCoverage: { recordedItemCount: 1, totalItemCount: 1 },
  });
  expect(a.totalVariancePercent).toBeCloseTo(phase === 'original' ? 25 : 50, 6);

  // Blair: an explicit active zero is recorded, unlike Casey's missing fact.
  const b = person(f.blair);
  expect(b).toMatchObject({
    knownPlannedMinutes: 60,
    actualMinutes: 0,
    totalVarianceMinutes: -60,
    factCoverage: { recordedItemCount: 1, totalItemCount: 1 },
  });
  expect(b.totalVariancePercent).toBeCloseTo(-100, 6);

  expect(person(f.casey)).toMatchObject({
    knownPlannedMinutes: 90,
    baselineCompleteness: { knownItemCount: 1, totalItemCount: 1 },
    factCoverage: { recordedItemCount: 0, totalItemCount: 1 },
    totalVarianceMinutes: null,
    totalVariancePercent: null,
  });

  expect(person(f.devon)).toMatchObject({
    baselineCompleteness: { knownItemCount: 0, totalItemCount: 1 },
    actualMinutes: 45,
    factCoverage: { recordedItemCount: 1, totalItemCount: 1 },
    totalVarianceMinutes: null,
    totalVariancePercent: null,
  });

  expect(person(f.ellis)).toMatchObject({
    baselineCompleteness: { totalItemCount: 0 },
    factCoverage: { totalItemCount: 0 },
    addedActualMinutes: 20,
    unplannedActualMinutes: 10,
    totalActualMinutes: 30,
  });
}

function bucket(run: WorkTypeReportRunDto, optionId: string | null) {
  const found = run.byCategory.find((entry) =>
    optionId === null ? entry.fieldId === null && entry.optionId === null : entry.optionId === optionId,
  );
  if (!found) throw new Error('Work-type bucket is missing.');
  return found;
}

function expectWorkTypeTotals(
  run: WorkTypeReportRunDto,
  data: ReportDataset,
  oracle: typeof WORK_TYPE_ORIGINAL | typeof WORK_TYPE_CORRECTED,
): void {
  expect(run.totalActualMinutes).toBe(oracle.total);
  expect(run.categorizedMinutes).toBe(oracle.categorized);
  expect(run.uncategorizedMinutes).toBe(oracle.uncategorized);
  expect(bucket(run, data.designId).minutes).toBe(oracle.design);
  expect(bucket(run, data.maintenanceId).minutes).toBe(oracle.maintenance);
  expect(bucket(run, null).minutes).toBe(oracle.uncategorized);
}

function expectShare(run: WorkTypeReportRunDto, optionId: string | null, percent: number): void {
  const share = bucket(run, optionId).sharePercent;
  if (share === null) throw new Error('Work-type share is unexpectedly undefined.');
  expect(share).toBeCloseTo(percent, 6);
}

function expectWorkTypePeople(run: WorkTypeReportRunDto, f: ReportWorkspace): void {
  expect(run.byPerson).toHaveLength(5);
  const person = (member: MembershipDto) => {
    const found = run.byPerson.find((entry) => entry.membershipId === member.id);
    if (!found) throw new Error(`Saved person ${member.displayName} is missing.`);
    return { minutes: found.totalActualMinutes, sources: found.activeSourceCount };
  };
  expect(person(f.owner)).toEqual({ minutes: 150, sources: 1 });
  expect(person(f.blair)).toEqual({ minutes: 0, sources: 1 });
  expect(person(f.casey)).toEqual({ minutes: 0, sources: 0 });
  expect(person(f.devon)).toEqual({ minutes: 45, sources: 1 });
  expect(person(f.ellis)).toEqual({ minutes: 30, sources: 2 });
  expect(run.byPerson.find(entry => entry.membershipId === f.casey.id)?.byCategory).toEqual([]);
  const zeroBuckets = run.byPerson.find(entry => entry.membershipId === f.blair.id)?.byCategory;
  expect(zeroBuckets).toHaveLength(1);
  expect(zeroBuckets?.[0]).toMatchObject({ minutes: 0, sharePercent: null });
}

function rowHasSavedLog(rows: readonly WeeklyPlanFactRowDto[], taskId: string, revisionId: string, minutes: number): boolean {
  return rows.some(row => row.taskIds.includes(taskId) && row.workLogs.some(log =>
    log.taskId === taskId && log.revisionId === revisionId && log.minutes === minutes && log.state === 'active'));
}

// ---------- UI helpers ----------

function weeklyUrl(workspaceId: string, projectId: string, periodId: string, worker: string, view: string): string {
  const params = new URLSearchParams({ period: periodId, worker, view });
  return `${REPORT_APP}/app/w/${workspaceId}/projects/${projectId}/week?${params.toString()}`;
}

function expectWorker(page: Page, membershipId: string): void {
  expect(new URL(page.url()).searchParams.get('worker')).toBe(membershipId);
}

async function expectSavedIdentity(savedReport: Locator, run: WeeklyPlanFactReportRunDto, names: string[]): Promise<void> {
  const identity = savedReport.locator('dl[aria-label="Saved report identity"]');
  await expect(identity).toBeVisible();
  await expect(identity).toContainText(PERIOD_TIMEZONE);
  await expect(identity).toContainText(/May 3, 2027.*May 9, 2027/);
  await expect(metricValue(identity, 'People').getByText('5 people in saved report', { exact: true })).toBeVisible();
  await expect(identity).not.toContainText('Los_Angeles');
  // Full short-date clocks are compared independently in the period zone, including time and calendar date.
  const inPeriod = (value: string) => new Intl.DateTimeFormat('en', {
    dateStyle: 'short', timeStyle: 'short', timeZone: PERIOD_TIMEZONE,
  }).format(new Date(value));
  await expect(metricValue(identity, 'Calculated')).toHaveText(inPeriod(run.createdAt));
  await expect(metricValue(identity, 'Actual hours included through')).toHaveText(inPeriod(run.factCutoffAt));
  await savedReport.locator('summary').filter({ hasText: /^Show saved names$/ }).click();
  for (const name of names) {
    await expect(savedReport).toContainText(name);
  }
}

async function expectComparisonRows(table: Locator, names: string[], ownerName: string): Promise<void> {
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveCount(8);
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  for (const [index, name] of names.entries()) {
    await expect(rows.nth(index).locator('th')).toHaveText(name);
    await expect(rows.nth(index).locator('td')).toHaveCount(7);
  }
  const owner = rowFor(table, ownerName);
  await expect(owner).toContainText('2h');
  await expect(owner).toContainText('2h 30m');
  await expect(owner).toContainText('+30m');
  const blair = rowFor(table, BLAIR);
  await expect(blair).toContainText('1h');
  await expect(blair).toContainText('0m');
  await expect(blair).toContainText(/[-−]1h/);
  await expect(blair).not.toContainText('Not recorded');
  const casey = rowFor(table, CASEY);
  await expect(casey).toContainText('1h 30m');
  await expect(casey).toContainText('Not recorded');
  await expect(casey).toContainText('Insufficient data');
  const devon = rowFor(table, DEVON);
  await expect(devon).toContainText('Not known');
  await expect(devon).toContainText('45m');
  await expect(devon).toContainText('Insufficient data');
  const ellis = rowFor(table, ELLIS);
  await expect(ellis).toContainText('No baseline work');
  await expect(ellis).toContainText('20m');
  await expect(ellis).toContainText('10m');
  await expect(ellis).toContainText('30m');
}

function rowFor(table: Locator, name: string): Locator {
  return table.locator('tbody tr').filter({ has: table.page().locator('th', { hasText: name }) });
}

/** The dd of the metric whose dt has exactly this label. */
function metricValue(scope: Locator, label: string): Locator {
  return scope.locator(`xpath=.//dt[normalize-space(.)="${label}"]/parent::div/dd`);
}

/** The identity People dd; it also holds Show saved names, so callers match only its exact count text. */
function peopleEntry(scope: Locator): Locator {
  return metricValue(scope.locator('dl[aria-label="Saved report identity"]'), 'People');
}

/** Chooses the theme only through the real toggle; never by writing storage or classes. */
async function chooseTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Dark theme', exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== String(theme === 'dark')) await toggle.click();
  await expectTheme(page, theme);
}

async function expectTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect(page.getByRole('button', { name: 'Dark theme', exact: true })).toHaveAttribute(
    'aria-pressed',
    String(theme === 'dark'),
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** A metric dd (identity dd values are dates/zones/people, never hours) showing exactly this hour value. */
function metricWithValue(scope: Locator, value: string): Locator {
  return scope.locator(`xpath=.//div[dt]/dd[normalize-space(.)="${value}"]`).first();
}

function personSummary(name: string, entries: number): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(name)} · .+ · entries ${entries}\\s*$`);
}

async function clickAndCapturePost(
  page: Page,
  button: Locator,
  pathname: string,
): Promise<{ body: unknown; idempotencyKey: string; response: unknown }> {
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === pathname,
  );
  await button.click();
  const request = await requestPromise;
  const response = await request.response();
  if (!response) throw new Error('Report calculation had no response.');
  expect(response.status(), `POST ${pathname}`).toBe(201);
  return {
    body: request.postDataJSON() as unknown,
    idempotencyKey: (await request.headerValue('idempotency-key')) ?? '',
    response: (await response.json()) as unknown,
  };
}

function trackBrowserMutations(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== REPORT_APP || !url.pathname.startsWith('/api/')) return;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    seen.push(`${method} ${url.pathname}`);
  });
  return seen;
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Scrolls the table's own overflow container (never body) and proves the overflow stays contained in it. */
async function scrollTableHorizontally(table: Locator): Promise<void> {
  const handle = await table.evaluateHandle((element) => {
    let node = element.parentElement;
    while (node && node !== document.body) {
      const overflowX = getComputedStyle(node).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth) return node;
      node = node.parentElement;
    }
    return null;
  });
  const container = handle.asElement();
  if (!container) throw new Error('Comparison table has no own horizontal scroll container before body.');
  const widths = await container.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  expect(widths.scroll).toBeGreaterThan(widths.client);
  await container.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
  await expect.poll(() => container.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  const box = await container.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.viewport);
  expect(await pageOverflow(table.page())).toBeLessThanOrEqual(0);
  await handle.dispose();
}

async function storageContains(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle) => {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null && (storage.getItem(key) ?? '').includes(needle)) return true;
      }
    }
    return false;
  }, text);
}

// ---------- JSON helpers ----------

/** A saved-report reread: identical data and stable meta; only the per-request meta.requestId may differ. */
function expectSameSavedEnvelope<TData, TMeta extends { requestId: string }>(
  actual: { data: TData; meta: TMeta },
  expected: { data: TData; meta: TMeta },
): void {
  const stableMeta = (meta: TMeta) => Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'requestId'));
  // Widened to unknown: Playwright cannot resolve its matcher set for an unconstrained generic TData.
  const actualData: unknown = actual.data;
  expect(actualData).toEqual(expected.data);
  expect(stableMeta(actual.meta)).toEqual(stableMeta(expected.meta));
  expect(actual.meta.requestId.length).toBeGreaterThan(0);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Expected an array.');
  return value.map((entry) => String(entry)).sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
