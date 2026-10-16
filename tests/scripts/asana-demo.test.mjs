import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '@workloom/contracts';
import { assertBeforeCutoff, CATEGORIES, compareReports, DEMO, DemoError, describeError, expectedOracle, FACTS, LATE_PLANS, LATE_TASKS, main, MEETING, PEOPLE, PLANS,
  stableId, TASKS, taskBody, UNCATEGORIZED } from '../../scripts/bootstrap-asana-demo.mjs';

const sum = values => values.reduce((total, value) => total + value, 0);
const id = label => stableId(`offline-test:${label}`);
const pick = (summary, fields) => Object.fromEntries(fields.map(field => [field, summary[field]]));

test('fixture uses exactly the five allowlisted non-viewer actors, four root tasks each, English-only literals', () => {
  assert.deepEqual(PEOPLE.map(person => [person.label, person.fixtureName, person.role]), [
    ['Mark', 'Synthetic Owner', 'owner'], ['Andrei', 'Synthetic Admin', 'admin'], ['Anna', 'Synthetic Member A', 'member'],
    ['Michael', 'Synthetic Member B', 'member'], ['Pavel', 'Synthetic Member C', 'member']]);
  assert.deepEqual(PEOPLE.map(person => person.userId.slice(-3)), ['101', '102', '103', '104', '105']);
  for (const person of PEOPLE) assert.equal(TASKS.filter(task => task.person === person.key && !task.parent).length, 4);
  const titles = [...TASKS, ...LATE_TASKS].map(task => task.title).concat(MEETING.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.doesNotMatch(JSON.stringify([TASKS, LATE_TASKS, MEETING, CATEGORIES, DEMO]), /[А-Яа-яЁё]/);
  assert.deepEqual(TASKS.filter(task => task.parent).map(task => [task.key, task.estimate]), [['persistent-views-storage', undefined]]);
  assert.deepEqual(TASKS.filter(task => task.estimate === null).map(task => task.key), ['flaky-ci']);
  assert.deepEqual(TASKS.filter(task => task.category === null).map(task => task.key), ['inbox-triage']);
  for (const task of TASKS.filter(item => !item.parent)) assert.ok(PLANS.some(([key]) => key === task.key), `${task.key} has a frozen personal plan`);
});

test('fixed week, cutoff and meeting instant are explicit and consistent in Asia/Nicosia', () => {
  const local = instant => new Intl.DateTimeFormat('en-CA', { timeZone: DEMO.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).format(new Date(instant));
  assert.equal(new Date(`${DEMO.week}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(local(DEMO.cutoffAt), 'Mon, 2026-10-26, 00:00');
  assert.equal(local(MEETING.plannedStartAt), 'Wed, 2026-10-14, 10:00');
  for (const task of [...TASKS, ...LATE_TASKS]) assert.ok(task.due >= 0 && task.due <= 6);
});

test('hand-computed literal totals pin the oracle: team package vs personal plans vs facts stay distinct', () => {
  const oracle = expectedOracle();
  assert.deepEqual(oracle.team, { knownPlannedMinutes: 5640, actualMinutes: 5085, missingEstimateCount: 0, knownItemCount: 26, recordedItemCount: 24, totalItemCount: 26,
    totalVarianceMinutes: null, totalVariancePercent: null, addedActualMinutes: 150, unplannedActualMinutes: 45, totalActualMinutes: 5280 });
  const fields = ['knownPlannedMinutes', 'actualMinutes', 'recordedItemCount', 'totalItemCount', 'totalVarianceMinutes', 'addedActualMinutes', 'unplannedActualMinutes', 'totalActualMinutes'];
  assert.deepEqual(Object.fromEntries(Object.entries(oracle.byPerson).map(([key, value]) => [key, pick(value, fields)])), {
    mark: { knownPlannedMinutes: 780, actualMinutes: 540, recordedItemCount: 4, totalItemCount: 5, totalVarianceMinutes: null, addedActualMinutes: 0, unplannedActualMinutes: 0, totalActualMinutes: 540 },
    andrei: { knownPlannedMinutes: 1500, actualMinutes: 1470, recordedItemCount: 6, totalItemCount: 6, totalVarianceMinutes: -30, addedActualMinutes: 150, unplannedActualMinutes: 0, totalActualMinutes: 1620 },
    anna: { knownPlannedMinutes: 1140, actualMinutes: 990, recordedItemCount: 4, totalItemCount: 5, totalVarianceMinutes: null, addedActualMinutes: 0, unplannedActualMinutes: 0, totalActualMinutes: 990 },
    michael: { knownPlannedMinutes: 1200, actualMinutes: 1140, recordedItemCount: 5, totalItemCount: 5, totalVarianceMinutes: -60, addedActualMinutes: 0, unplannedActualMinutes: 0, totalActualMinutes: 1140 },
    pavel: { knownPlannedMinutes: 1020, actualMinutes: 945, recordedItemCount: 5, totalItemCount: 5, totalVarianceMinutes: -75, addedActualMinutes: 0, unplannedActualMinutes: 45, totalActualMinutes: 990 },
  });
  assert.equal(oracle.byPerson.andrei.totalVariancePercent, -2);
  assert.ok(Math.abs(oracle.byPerson.pavel.totalVariancePercent - (-75 / 1020 * 100)) < 1e-12);
  assert.deepEqual(oracle.workTypes.byCategory, { Management: 690, 'Client support': 870, Bug: 825, 'Core feature': 1920, 'Side feature': 930, [UNCATEGORIZED]: 45 });
  assert.deepEqual(pick(oracle.workTypes, ['totalActualMinutes', 'activeSourceCount', 'categorizedMinutes', 'uncategorizedMinutes']), { totalActualMinutes: 5280, activeSourceCount: 27, categorizedMinutes: 5235, uncategorizedMinutes: 45 });
  assert.deepEqual(oracle.workTypes.byPerson.mark, { totalActualMinutes: 540, activeSourceCount: 4, byCategory: { Management: 540, 'Client support': 0 } });
  assert.deepEqual(oracle.workTypes.byPerson.pavel, { totalActualMinutes: 990, activeSourceCount: 6, byCategory: { 'Client support': 750, 'Side feature': 150, [UNCATEGORIZED]: 45, Bug: 45, Management: 0 } });
  assert.deepEqual(oracle.meeting, { packageEstimateMinutes: 300, plannedMinutes: 300, actualMinutes: 210, sourceCount: 5, byPerson: { mark: 60, andrei: 60, anna: 60, michael: 30, pavel: 0 } });
  assert.deepEqual(oracle.packages, { teamKnownEstimateMinutes: 7260, unknownEstimateCount: 1, naiveRowEstimateSumMinutes: 9180, sharedPackages: { 'persistent-views': 2, 'team-call': 5 } });
  assert.equal(oracle.rows.length, 28);
  assert.deepEqual(oracle.rows.filter(row => row.scope !== 'original').map(row => [row.key, row.scope, row.plannedMinutes, row.actualMinutes]), [
    ['android-crash:pavel', 'unplanned', null, 45], ['hotfix-merge-regression:andrei', 'added_scope', 120, 150]]);
});

test('false sums from naive arithmetic over the literal fixture differ from the oracle', () => {
  const oracle = expectedOracle();
  const manualFacts = sum(FACTS.map(([, , minutes]) => minutes));
  assert.equal(manualFacts, 5070); // drops meeting attendance
  assert.notEqual(manualFacts, oracle.team.actualMinutes); assert.notEqual(manualFacts, oracle.team.totalActualMinutes);
  assert.notEqual(MEETING.plannedDurationMinutes * MEETING.attendees.length, oracle.meeting.actualMinutes); // presence assumed from the invitation
  assert.notEqual(oracle.packages.naiveRowEstimateSumMinutes, oracle.packages.teamKnownEstimateMinutes); // shared/meeting package per row
  assert.notEqual(sum(PLANS.map(([, , minutes]) => minutes)) + sum(LATE_PLANS.map(([, , minutes]) => minutes)), oracle.team.knownPlannedMinutes); // late plan is not original
  assert.notEqual(oracle.workTypes.categorizedMinutes, oracle.workTypes.totalActualMinutes); // uncategorized stays in the denominator
  // Missing facts are not zero: two original rows are unrecorded, while a recorded zero and an absence count as recorded.
  const byKey = key => oracle.rows.find(row => row.key === key);
  assert.deepEqual([byKey('roadmap:mark'), byKey('board-focus:anna')].map(row => [row.actualMinutes, row.factRecorded]), [[0, false], [0, false]]);
  assert.deepEqual([byKey('escalations:mark'), byKey('team-call:pavel')].map(row => [row.actualMinutes, row.factRecorded]), [[0, true], [0, true]]);
  assert.deepEqual(byKey('persistent-views:anna').actualMinutes, 420); // parent 360 + detail subtask 60 in one package row
});

function simulated() {
  const oracle = expectedOracle();
  const ids = { memberships: Object.fromEntries(PEOPLE.map(person => [person.key, id(`member:${person.key}`)])),
    packages: Object.fromEntries([...new Set(oracle.rows.map(row => row.pkg))].map(key => [key, id(`package:${key}`)])),
    options: Object.fromEntries(CATEGORIES.map(item => [item.name, id(`option:${item.name}`)])) };
  const packageOf = key => [...TASKS, ...LATE_TASKS].find(task => task.key === key)?.parent ?? key;
  const logs = [...FACTS.map(([task, person, minutes]) => ({ pkg: packageOf(task), person, minutes, sourceKind: 'manual_period' })),
    ...Object.entries({ mark: 60, andrei: 60, anna: 60, michael: 30, pavel: 0 }).map(([person, minutes]) => ({ pkg: MEETING.key, person, minutes, sourceKind: 'meeting_attendance' }))];
  let seq = 1000;
  const nested = s => ({ knownPlannedMinutes: s.knownPlannedMinutes, actualMinutes: s.actualMinutes, missingEstimateCount: s.missingEstimateCount,
    baselineCompleteness: { knownItemCount: s.knownItemCount, totalItemCount: s.totalItemCount }, factCoverage: { recordedItemCount: s.recordedItemCount, totalItemCount: s.totalItemCount },
    totalVarianceMinutes: s.totalVarianceMinutes, totalVariancePercent: s.totalVariancePercent, addedActualMinutes: s.addedActualMinutes, unplannedActualMinutes: s.unplannedActualMinutes, totalActualMinutes: s.totalActualMinutes });
  const buckets = map => Object.entries(map).map(([name, minutes]) => ({ optionId: name === UNCATEGORIZED ? null : ids.options[name], minutes }));
  const weeklyRows = oracle.rows.map(row => ({ scope: row.scope, workPackageId: ids.packages[row.pkg], membershipId: ids.memberships[row.person], plannedMinutes: row.plannedMinutes,
    actualMinutes: row.actualMinutes, factRecorded: row.factRecorded, packageEstimateMinutes: row.packageEstimateMinutes, packageBaselineId: row.packageEstimateMinutes === null ? null : id(`baseline:${row.pkg}`),
    workLogs: logs.filter(log => log.pkg === row.pkg && log.person === row.person).map(log => ({ sourceKind: log.sourceKind, minutes: log.minutes, state: 'active', changeSeq: String(seq++) })) }));
  const workTypes = oracle.workTypes;
  return { ids, observed: { baseline: { scope: 'project', mode: 'manual', changeSeq: '500' },
    weekly: { summary: nested(oracle.team), byPerson: PEOPLE.map(person => ({ membershipId: ids.memberships[person.key], summary: nested(oracle.byPerson[person.key]) })), rowCount: weeklyRows.length },
    weeklyRows,
    workType: { totalActualMinutes: workTypes.totalActualMinutes, activeSourceCount: workTypes.activeSourceCount, categorizedMinutes: workTypes.categorizedMinutes, uncategorizedMinutes: workTypes.uncategorizedMinutes,
      byCategory: buckets(workTypes.byCategory), byPerson: PEOPLE.map(person => ({ membershipId: ids.memberships[person.key], ...workTypes.byPerson[person.key], byCategory: buckets(workTypes.byPerson[person.key].byCategory) })) } } };
}
function failures(mutate) {
  const { ids, observed } = simulated();
  const row = (pkg, person) => observed.weeklyRows.find(item => item.workPackageId === ids.packages[pkg] && item.membershipId === ids.memberships[person]);
  mutate(observed, row, ids);
  return compareReports(expectedOracle(), observed, ids).failures.map(failure => failure.name);
}

test('comparator accepts a report shaped like the real contracts that matches the oracle', () => {
  const { ids, observed } = simulated();
  const result = compareReports(expectedOracle(), observed, ids);
  assert.deepEqual(result.failures, []); assert.ok(result.passed > 200, `${result.passed} checks`);
  // The fields the comparator reads exist in the real strict contracts.
  for (const [schema, keys] of [[C.weeklyPlanFactRowSchema, ['scope', 'workPackageId', 'membershipId', 'plannedMinutes', 'actualMinutes', 'factRecorded', 'packageEstimateMinutes', 'packageBaselineId', 'workLogs']],
    [C.weeklyPlanFactSummarySchema, Object.keys(observed.weekly.summary)], [C.weeklyPlanFactReportRunSchema, ['summary', 'byPerson', 'rowCount']], [C.planBaselineSchema, ['scope', 'mode', 'changeSeq']],
    [C.manualPeriodWorkLogSchema, ['sourceKind', 'minutes', 'state', 'changeSeq']], [C.workTypeBucketSchema, ['optionId', 'minutes']],
    [C.workTypeReportRunSchema, ['totalActualMinutes', 'activeSourceCount', 'categorizedMinutes', 'uncategorizedMinutes', 'byCategory', 'byPerson']]]) for (const key of keys) assert.ok(key in schema.shape, key);
});

test('comparator flags each realistic reporting mistake with a specific check', () => {
  const includes = (names, ...expected) => { for (const name of expected) assert.ok(names.includes(name), `${name} in ${names.join(', ')}`); };
  includes(failures((_, row) => { row('team-call', 'michael').actualMinutes = 60; row('team-call', 'pavel').actualMinutes = 60; }), 'meeting.actualMinutes', 'row.team-call:michael.actualMinutes', 'row.team-call:pavel.actualMinutes');
  includes(failures((observed, row) => { row('roadmap', 'mark').factRecorded = true; observed.weekly.summary.factCoverage.recordedItemCount = 25; }), 'row.roadmap:mark.factRecorded', 'weekly.team.recordedItemCount');
  includes(failures((_, row) => { row('team-call', 'pavel').factRecorded = false; }), 'row.team-call:pavel.factRecorded');
  includes(failures((observed, row) => { row('android-crash', 'pavel').scope = 'added_scope'; observed.weekly.summary.unplannedActualMinutes = 0; observed.weekly.summary.addedActualMinutes = 195; }),
    'row.android-crash:pavel.scope', 'weekly.team.unplannedActualMinutes', 'weekly.team.addedActualMinutes');
  includes(failures(observed => { observed.workType.byCategory = observed.workType.byCategory.filter(bucket => bucket.optionId !== null); observed.workType.totalActualMinutes = 5235; }),
    `workType.team.${UNCATEGORIZED}`, 'workType.team.totalActualMinutes', 'crossReport.totalActualMinutes');
  includes(failures((_, row) => { row('review-mrs', 'mark').workLogs[0].changeSeq = '499'; }), 'facts.recordedBeforeFreeze');
  includes(failures((_, row) => { row('persistent-views', 'andrei').packageBaselineId = id('second-baseline'); }), 'packages.persistent-views.distinctBaselines', 'packages.teamKnownEstimateMinutes');
  includes(failures((_, row) => { row('flaky-ci', 'andrei').packageEstimateMinutes = 0; }), 'row.flaky-ci:andrei.packageEstimateMinutes');
  includes(failures(observed => { observed.baseline.mode = 'cutoff'; }), 'baseline.mode');
  includes(failures((observed, _, ids) => { observed.weeklyRows.push({ ...observed.weeklyRows[0], workPackageId: id('stray'), membershipId: ids.memberships.anna, workLogs: [] }); }), 'row.unexpected', 'weekly.rowsRead');
  includes(failures((observed, _, ids) => { observed.workType.byPerson.find(item => item.membershipId === ids.memberships.mark).byCategory.push({ optionId: ids.options.Bug, minutes: 0 }); }), 'workType.mark.unexpectedBuckets');
});

test('real strict contracts accept every planned task, plan, meeting, fact and attendance body', () => {
  const membership = key => id(`member:${key}`), tagId = key => id(`tag:${key}`);
  for (const [position, task] of [...TASKS, ...LATE_TASKS].entries()) {
    const body = C.createTaskInputSchema.parse(taskBody(task, { projectId: id('project'), sectionId: id('section'), statusId: id(task.group), membership, tagId, parentId: id('parent'), position }));
    assert.equal('estimateMinutes' in body, !task.parent); assert.equal(body.parentTaskId, task.parent ? id('parent') : undefined);
    assert.ok(body.startDate <= body.dueDate && body.dueDate < '2026-10-19' && body.startDate >= DEMO.week);
  }
  for (const [task, person, minutes] of [...PLANS, ...LATE_PLANS]) C.createPeriodCommitmentInputSchema.parse({ workPackageId: id(`package:${task}`), membershipId: membership(person), expectedAbsent: true, plannedMinutes: minutes, allocations: [{ taskId: id(task), minutes }] });
  for (const [, , minutes] of FACTS) C.setManualPeriodWorkInputSchema.parse({ expectedRevision: null, minutes, state: 'active', reason: 'Synthetic weekly demo fact' });
  C.createMeetingInputSchema.parse({ title: MEETING.title, statusId: id('done'), sectionId: id('rituals'), plannedPeriodId: id('period'), plannedStartAt: MEETING.plannedStartAt, timezone: DEMO.timezone,
    plannedDurationMinutes: MEETING.plannedDurationMinutes, organizerMembershipId: membership(MEETING.organizer), attendeeMembershipIds: MEETING.attendees.map(membership) });
  C.createPlanningPeriodInputSchema.parse({ projectId: id('project'), name: DEMO.periodName, localStart: DEMO.week, timezone: DEMO.timezone, cutoffAt: DEMO.cutoffAt, protectedFieldIds: [], protectEstimate: false });
  C.confirmAttendanceInputSchema.parse({ expectedMeetingRevision: 2, periodId: id('period'), rows: MEETING.attendees.map(person => {
    const posted = MEETING.attendance[person];
    return { attendanceId: id(`attendance:${person}`), expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: posted.status, attributionBasis: 'actual_meeting', ...(posted.status === 'partial' ? { minutes: posted.minutes } : {}) };
  }) });
  C.createTaskFieldInputSchema.parse({ projectId: id('project'), name: 'Work type', type: 'single_select', options: CATEGORIES });
});

test('default and explicit dry-run are offline; unsupported arguments are refused', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be used'); };
  try {
    for (const args of [[], ['--dry-run']]) {
      const lines = []; await main(args, { log: line => lines.push(line) });
      const output = JSON.parse(lines.join('\n'));
      assert.match(output.mode, /no network or database access/); assert.equal(output.expected.team.totalActualMinutes, 5280);
      assert.equal(output.people.length, 5); assert.doesNotMatch(lines.join('\n'), /DATABASE_URL|postgres:\/\/|password/i);
    }
    await assert.rejects(main(['--execute', '--verify']), /Usage/); await assert.rejects(main(['--reset']), /Usage/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
});

test('cutoff guard refuses before any request once the fixed cutoff is near, unless the freeze was acknowledged', () => {
  const cutoff = Date.parse(DEMO.cutoffAt);
  assert.doesNotThrow(() => assertBeforeCutoff({ commands: {} }, cutoff - 2 * 3600_000));
  assert.throws(() => assertBeforeCutoff({ commands: {} }, cutoff - 30 * 60_000), DemoError);
  assert.throws(() => assertBeforeCutoff({ commands: { freeze: { body: {} } } }, cutoff + 1), DemoError);
  assert.doesNotThrow(() => assertBeforeCutoff({ commands: { freeze: { response: { id: id('baseline') } } } }, cutoff + 1));
});

test('error text never echoes connection strings or arbitrary messages', () => {
  const leaked = Object.assign(new Error('connect failed for postgres://demo:secret@127.0.0.1:55432/workloom'), { code: 'ECONNREFUSED' });
  assert.equal(describeError(leaked), 'Error (ECONNREFUSED)');
  assert.equal(describeError(new TypeError('fetch failed http://user:secret@host')), 'TypeError');
  assert.equal(describeError(new Error('API returned 409 (REVISION_CONFLICT). Preserve the manifest and retry the original operation.')), 'API returned 409 (REVISION_CONFLICT). Preserve the manifest and retry the original operation.');
  assert.equal(describeError(new DemoError('Controlled message.')), 'Controlled message.');
});
