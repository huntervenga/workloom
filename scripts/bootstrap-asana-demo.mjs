#!/usr/bin/env node
// Additive Asana-style weekly planning demo. Default is an offline dry-run; --execute and --verify are deliberate.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { validateLocalEnvironment } from './local-runtime.mjs';
import { writePrivateJson } from './private-json.mjs';
import { createCommandJournal, requestDemoJson, resumeOrPrepare } from './demo-command-journal.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.local/demo');
const MANIFEST = join(DIRECTORY, 'asana-v1.json');
const NAMESPACE = 'workloom-asana-style-demo-v1';
const APP = 'http://127.0.0.1:4310';
const OLD_WORKSPACE = '5eed0000-0000-4000-8000-000000000201';
const WORKSPACE = stableId('workspace');
const BASE = `/api/v1/workspaces/${WORKSPACE}`;
const CUTOFF_MARGIN_MS = 60 * 60 * 1000;
export const UNCATEGORIZED = 'Uncategorized';
let phase = 'argument validation';
export class DemoError extends Error {}

export function stableId(label) {
  const raw = createHash('sha256').update(`${NAMESPACE}:${label}`).digest('hex').slice(0, 32).split('');
  raw[12] = '4'; raw[16] = '8';
  const value = raw.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function digest(rows) { return createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function dateAt(week, offset) { const date = new Date(`${week}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
const sum = values => values.reduce((total, value) => total + value, 0);
export function hm(minutes) { return minutes === null ? 'unknown' : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`; }

// Fixed explicit demo week. Cutoff is 00:00 Monday 26 Oct Asia/Nicosia, so the explicit manual freeze is the one exercised.
export const DEMO = { workspaceName: 'Team planning demo', projectName: 'Weekly team planning', periodName: 'Week of 12 Oct',
  week: '2026-10-12', timezone: 'Asia/Nicosia', cutoffAt: '2026-10-25T22:00:00.000Z' };
// Persona labels group sections only. Actor display names stay the existing synthetic fixture names.
export const PEOPLE = [
  { key: 'mark', label: 'Mark', userId: '5eed0000-0000-4000-8000-000000000101', fixtureName: 'Synthetic Owner', role: 'owner' },
  { key: 'andrei', label: 'Andrei', userId: '5eed0000-0000-4000-8000-000000000102', fixtureName: 'Synthetic Admin', role: 'admin' },
  { key: 'anna', label: 'Anna', userId: '5eed0000-0000-4000-8000-000000000103', fixtureName: 'Synthetic Member A', role: 'member' },
  { key: 'michael', label: 'Michael', userId: '5eed0000-0000-4000-8000-000000000104', fixtureName: 'Synthetic Member B', role: 'member' },
  { key: 'pavel', label: 'Pavel', userId: '5eed0000-0000-4000-8000-000000000105', fixtureName: 'Synthetic Member C', role: 'member' },
];
export const sectionName = person => `${person.label} (${person.fixtureName})`;
export const CATEGORIES = [
  { name: 'Bug', color: '#ef4444' }, { name: 'Core feature', color: '#6366f1' }, { name: 'Side feature', color: '#0ea5e9' },
  { name: 'Client support', color: '#f59e0b' }, { name: 'Management', color: '#10b981' },
];
export const TAGS = [
  { key: 'backend', name: 'Backend', color: '#6366f1' }, { key: 'frontend', name: 'Frontend', color: '#ec4899' },
  { key: 'android', name: 'Android', color: '#22c55e' }, { key: 'clients', name: 'Clients', color: '#f59e0b' },
  { key: 'gdpr', name: 'GDPR', color: '#8b5cf6' }, { key: 'code-review', name: 'Code review', color: '#64748b' },
  { key: 'performance', name: 'Performance', color: '#14b8a6' }, { key: 'support', name: 'Support', color: '#f97316' },
];
// estimate = whole team package (minutes, null = unknown). A detail subtask has no estimate: it shares its parent's package.
export const TASKS = [
  { key: 'review-mrs', person: 'mark', title: 'Review open merge requests', estimate: 360, group: 'done', priority: 'high', category: 'Management', tags: ['code-review'], due: 4 },
  { key: 'one-on-ones', person: 'mark', title: 'Weekly one-on-ones with the team', estimate: 180, group: 'done', priority: 'medium', category: 'Management', tags: [], due: 3 },
  { key: 'roadmap', person: 'mark', title: 'Draft the Q4 roadmap update', estimate: 240, group: 'in_progress', priority: 'medium', category: 'Management', tags: [], due: 4 },
  { key: 'escalations', person: 'mark', title: 'Answer the client escalation backlog', estimate: 120, group: 'todo', priority: 'low', category: 'Client support', tags: ['clients'], due: 4 },
  { key: 'merge-issue', person: 'andrei', title: 'Fix the task merge issue in sync', estimate: 300, group: 'done', priority: 'urgent', category: 'Bug', tags: ['backend'], due: 1 },
  { key: 'gdpr-api', person: 'andrei', title: 'GDPR data export API', estimate: 960, group: 'in_progress', priority: 'high', category: 'Core feature', tags: ['backend', 'gdpr'], due: 4 },
  { key: 'shop-overrides', person: 'andrei', title: 'Shop price overrides endpoint', estimate: 360, group: 'in_progress', priority: 'medium', category: 'Side feature', tags: ['backend'], due: 4 },
  { key: 'flaky-ci', person: 'andrei', title: 'Stabilise flaky CI checks', estimate: null, group: 'todo', priority: 'low', category: 'Bug', tags: [], due: 4 },
  { key: 'asset-views', person: 'anna', title: 'Tidy up asset views', estimate: 480, group: 'done', priority: 'medium', category: 'Side feature', tags: ['frontend'], due: 2 },
  { key: 'persistent-views', person: 'anna', participants: ['anna', 'andrei'], title: 'Persistent views for task lists', estimate: 720, group: 'in_progress', priority: 'high', category: 'Core feature', tags: ['frontend'], due: 4 },
  { key: 'persistent-views-storage', parent: 'persistent-views', person: 'andrei', participants: ['andrei', 'anna'], title: 'Persistent views: save view settings on the server', group: 'in_progress', priority: 'high', category: 'Core feature', tags: ['backend'], due: 4 },
  { key: 'northwind-onboarding', person: 'anna', title: 'Support Northwind client onboarding', estimate: 180, group: 'done', priority: 'medium', category: 'Client support', tags: ['clients'], due: 2 },
  { key: 'board-focus', person: 'anna', title: 'Fix keyboard focus on the board view', estimate: 120, group: 'todo', priority: 'high', category: 'Bug', tags: ['frontend'], due: 4 },
  { key: 'android-performance', person: 'michael', title: 'Improve Android list performance', estimate: 1200, group: 'in_progress', priority: 'high', category: 'Core feature', tags: ['android', 'performance'], due: 4 },
  { key: 'android-crash', person: 'michael', title: 'Fix Android crash on image upload', estimate: 240, group: 'done', priority: 'urgent', category: 'Bug', tags: ['android'], due: 1 },
  { key: 'release-notes', person: 'michael', title: 'Prepare Android release notes', estimate: 60, group: 'done', priority: 'low', category: 'Side feature', tags: ['android'], due: 3 },
  { key: 'offline-drafts', person: 'michael', title: 'Prototype offline drafts', estimate: 480, group: 'todo', priority: 'low', category: 'Side feature', tags: ['android'], due: 4 },
  { key: 'clients-support', person: 'pavel', title: 'Clients support rotation', estimate: 600, group: 'in_progress', priority: 'high', category: 'Client support', tags: ['clients', 'support'], due: 4 },
  { key: 'gdpr-client-guide', person: 'pavel', title: 'Document the GDPR export for clients', estimate: 180, group: 'todo', priority: 'medium', category: 'Client support', tags: ['gdpr', 'clients'], due: 4 },
  { key: 'support-macros', person: 'pavel', title: 'Update support reply macros', estimate: 120, group: 'done', priority: 'low', category: 'Side feature', tags: ['support'], due: 2 },
  { key: 'inbox-triage', person: 'pavel', title: 'Triage leftover inbox requests', estimate: 60, group: 'done', priority: 'low', category: null, tags: ['support'], due: 0 },
];
// Created after the freeze: server-classified added scope, never original.
export const LATE_TASKS = [
  { key: 'hotfix-merge-regression', person: 'andrei', title: 'Hotfix: merge issue regression after release', estimate: 120, group: 'in_progress', priority: 'urgent', category: 'Bug', tags: ['backend'], due: 4 },
];
// [allocated task, person, personal weekly plan minutes]; one commitment per package and person.
export const PLANS = [
  ['review-mrs', 'mark', 300], ['one-on-ones', 'mark', 180], ['roadmap', 'mark', 120], ['escalations', 'mark', 120],
  ['merge-issue', 'andrei', 300], ['gdpr-api', 'andrei', 600], ['shop-overrides', 'andrei', 240], ['flaky-ci', 'andrei', 120], ['persistent-views-storage', 'andrei', 180],
  ['asset-views', 'anna', 360], ['persistent-views', 'anna', 420], ['northwind-onboarding', 'anna', 180], ['board-focus', 'anna', 120],
  ['android-performance', 'michael', 720], ['android-crash', 'michael', 240], ['release-notes', 'michael', 60], ['offline-drafts', 'michael', 120],
  ['clients-support', 'pavel', 600], ['gdpr-client-guide', 'pavel', 180], ['support-macros', 'pavel', 120], ['inbox-triage', 'pavel', 60],
];
export const LATE_PLANS = [['hotfix-merge-regression', 'andrei', 120]];
// [task, person, weekly fact minutes], all recorded after the freeze. roadmap/mark and board-focus/anna deliberately have no fact.
export const FACTS = [
  ['review-mrs', 'mark', 330], ['one-on-ones', 'mark', 150], ['escalations', 'mark', 0],
  ['merge-issue', 'andrei', 360], ['gdpr-api', 'andrei', 510], ['shop-overrides', 'andrei', 240], ['flaky-ci', 'andrei', 90], ['persistent-views-storage', 'andrei', 210],
  ['asset-views', 'anna', 390], ['persistent-views', 'anna', 360], ['persistent-views-storage', 'anna', 60], ['northwind-onboarding', 'anna', 120],
  ['android-performance', 'michael', 780], ['android-crash', 'michael', 180], ['release-notes', 'michael', 60], ['offline-drafts', 'michael', 90],
  ['clients-support', 'pavel', 630], ['gdpr-client-guide', 'pavel', 120], ['support-macros', 'pavel', 150], ['inbox-triage', 'pavel', 45],
  ['android-crash', 'pavel', 45], ['hotfix-merge-regression', 'andrei', 150],
];
export const MEETING = { key: 'team-call', title: 'Weekly team planning call', plannedStartAt: '2026-10-14T07:00:00.000Z', plannedDurationMinutes: 60,
  actualDurationMinutes: 60, plannedMinutesPerPerson: 60, organizer: 'mark', attendees: ['mark', 'andrei', 'anna', 'michael', 'pavel'], category: 'Management',
  attendance: { mark: { status: 'present' }, andrei: { status: 'present' }, anna: { status: 'present' }, michael: { status: 'partial', minutes: 30 }, pavel: { status: 'absent' } } };
export const FIXTURE = { demo: DEMO, people: PEOPLE, categories: CATEGORIES, tags: TAGS, tasks: TASKS, lateTasks: LATE_TASKS, plans: PLANS, latePlans: LATE_PLANS, facts: FACTS, meeting: MEETING };

export function attendanceMinutes(meeting, person) {
  const row = meeting.attendance[person];
  return row.status === 'present' ? meeting.actualDurationMinutes : row.status === 'partial' ? row.minutes : 0;
}

/** Independent expected oracle from the literal fixture numbers above; it never reads returned report totals. */
export function expectedOracle(fixture = FIXTURE) {
  const { people, tasks, lateTasks, plans, latePlans, facts, meeting } = fixture;
  const persons = people.map(person => person.key), byKey = new Map([...tasks, ...lateTasks].map(task => [task.key, task]));
  const check = (ok, message) => { if (!ok) throw new Error(`Fixture: ${message}`); };
  for (const [task, person] of [...plans, ...latePlans, ...facts]) check(byKey.has(task) && persons.includes(person), `unknown reference ${task}/${person}`);
  for (const task of byKey.values()) check(!task.parent || (byKey.get(task.parent) && !byKey.get(task.parent).parent && task.estimate === undefined), `invalid detail subtask ${task.key}`);
  const packageOf = task => task === meeting.key ? task : byKey.get(task).parent ?? task;
  const frozen = new Set([...tasks.filter(task => !task.parent).map(task => task.key), meeting.key]);
  const estimate = pkg => pkg === meeting.key ? meeting.plannedDurationMinutes * meeting.attendees.length : byKey.get(pkg).estimate;
  const original = new Map(), added = new Map();
  for (const [task, person, minutes] of plans) { const key = `${packageOf(task)}:${person}`; check(!original.has(key), `duplicate plan ${key}`); original.set(key, minutes); }
  for (const person of meeting.attendees) original.set(`${meeting.key}:${person}`, meeting.plannedMinutesPerPerson);
  for (const [task, person, minutes] of latePlans) added.set(`${packageOf(task)}:${person}`, minutes);
  const sources = [...facts.map(([task, person, minutes]) => ({ task, person, minutes, kind: 'manual_period' })),
    ...meeting.attendees.map(person => ({ task: meeting.key, person, minutes: attendanceMinutes(meeting, person), kind: 'meeting_attendance' }))]
    .map(source => ({ ...source, pkg: packageOf(source.task), category: (source.task === meeting.key ? meeting.category : byKey.get(source.task).category) ?? UNCATEGORIZED }));
  const rows = [];
  for (const [key, planned] of original) {
    const [pkg, person] = key.split(':'), own = sources.filter(source => source.pkg === pkg && source.person === person);
    rows.push({ key, pkg, person, scope: 'original', plannedMinutes: planned, actualMinutes: sum(own.map(source => source.minutes)), factRecorded: own.length > 0, packageEstimateMinutes: estimate(pkg) ?? null });
  }
  for (const key of [...new Set([...sources.map(source => `${source.pkg}:${source.person}`), ...added.keys()])].filter(key => !original.has(key)).sort()) {
    const [pkg, person] = key.split(':'), own = sources.filter(source => source.pkg === pkg && source.person === person);
    rows.push({ key, pkg, person, scope: frozen.has(pkg) ? 'unplanned' : 'added_scope', plannedMinutes: added.get(key) ?? null, actualMinutes: sum(own.map(source => source.minutes)), factRecorded: own.length > 0, packageEstimateMinutes: null });
  }
  function summarize(list) {
    const originals = list.filter(row => row.scope === 'original'), known = originals.filter(row => row.plannedMinutes !== null), recorded = originals.filter(row => row.factRecorded);
    const planned = sum(known.map(row => row.plannedMinutes)), actual = sum(originals.map(row => row.actualMinutes));
    const complete = originals.length > 0 && known.length === originals.length && recorded.length === originals.length;
    const scoped = scope => sum(list.filter(row => row.scope === scope).map(row => row.actualMinutes));
    return { knownPlannedMinutes: planned, actualMinutes: actual, missingEstimateCount: originals.length - known.length, knownItemCount: known.length,
      recordedItemCount: recorded.length, totalItemCount: originals.length, totalVarianceMinutes: complete ? actual - planned : null,
      totalVariancePercent: complete && planned > 0 ? (actual - planned) / planned * 100 : null,
      addedActualMinutes: scoped('added_scope'), unplannedActualMinutes: scoped('unplanned'), totalActualMinutes: sum(list.map(row => row.actualMinutes)) };
  }
  const buckets = list => { const out = {}; for (const source of list) out[source.category] = (out[source.category] ?? 0) + source.minutes; return out; };
  const workType = list => ({ totalActualMinutes: sum(list.map(source => source.minutes)), activeSourceCount: list.length, byCategory: buckets(list) });
  const originalRows = rows.filter(row => row.scope === 'original'), meetingSources = sources.filter(source => source.pkg === meeting.key);
  const rowsPerPackage = {}; for (const row of originalRows) rowsPerPackage[row.pkg] = (rowsPerPackage[row.pkg] ?? 0) + 1;
  return { rows, team: summarize(rows), byPerson: Object.fromEntries(persons.map(person => [person, summarize(rows.filter(row => row.person === person))])),
    workTypes: { ...workType(sources), categorizedMinutes: sum(sources.filter(source => source.category !== UNCATEGORIZED).map(source => source.minutes)),
      uncategorizedMinutes: sum(sources.filter(source => source.category === UNCATEGORIZED).map(source => source.minutes)),
      byPerson: Object.fromEntries(persons.map(person => [person, workType(sources.filter(source => source.person === person))])) },
    packages: { teamKnownEstimateMinutes: sum([...frozen].map(estimate).filter(value => value !== null)), unknownEstimateCount: [...frozen].filter(pkg => estimate(pkg) === null).length,
      naiveRowEstimateSumMinutes: sum(originalRows.map(row => row.packageEstimateMinutes ?? 0)), sharedPackages: Object.fromEntries(Object.entries(rowsPerPackage).filter(([, count]) => count > 1)) },
    meeting: { packageEstimateMinutes: estimate(meeting.key), plannedMinutes: sum(originalRows.filter(row => row.pkg === meeting.key).map(row => row.plannedMinutes)),
      actualMinutes: sum(meetingSources.map(source => source.minutes)), sourceCount: meetingSources.length,
      byPerson: Object.fromEntries(meeting.attendees.map(person => [person, attendanceMinutes(meeting, person)])) },
    sourceCount: sources.length };
}

function flatSummary(summary) {
  return { knownPlannedMinutes: summary.knownPlannedMinutes, actualMinutes: summary.actualMinutes, missingEstimateCount: summary.missingEstimateCount,
    knownItemCount: summary.baselineCompleteness.knownItemCount, recordedItemCount: summary.factCoverage.recordedItemCount, totalItemCount: summary.factCoverage.totalItemCount,
    totalVarianceMinutes: summary.totalVarianceMinutes, totalVariancePercent: summary.totalVariancePercent, addedActualMinutes: summary.addedActualMinutes,
    unplannedActualMinutes: summary.unplannedActualMinutes, totalActualMinutes: summary.totalActualMinutes };
}
const sameValue = (expected, actual) => typeof expected === 'number' && typeof actual === 'number' ? Math.abs(expected - actual) < 1e-9 : expected === actual;

/**
 * Compares authoritative pinned reports against the oracle. `ids` maps fixture keys to runtime IDs:
 * { memberships: {person: id}, packages: {packageKey: id}, options: {category: id} }.
 * Returns only names and numeric/enum values, never row titles or other stored content.
 */
export function compareReports(oracle, observed, ids) {
  const checks = [], add = (name, expected, actual) => checks.push({ name, expected, actual: actual === undefined ? 'missing' : actual, ok: sameValue(expected, actual) });
  const invert = map => new Map(Object.entries(map).map(([key, id]) => [id.toLowerCase(), key]));
  const person = invert(ids.memberships), pkg = invert(ids.packages), option = invert(ids.options);
  const { baseline, weekly, weeklyRows, workType } = observed;
  add('baseline.scope', 'project', baseline.scope); add('baseline.mode', 'manual', baseline.mode);
  for (const [field, value] of Object.entries(oracle.team)) add(`weekly.team.${field}`, value, flatSummary(weekly.summary)[field]);
  add('weekly.byPerson.count', Object.keys(oracle.byPerson).length, weekly.byPerson.length);
  for (const [key, expected] of Object.entries(oracle.byPerson)) {
    const entry = weekly.byPerson.find(item => person.get(item.membershipId.toLowerCase()) === key);
    for (const [field, value] of Object.entries(expected)) add(`weekly.${key}.${field}`, value, entry ? flatSummary(entry.summary)[field] : undefined);
  }
  add('weekly.rowCount', oracle.rows.length, weekly.rowCount); add('weekly.rowsRead', oracle.rows.length, weeklyRows.length);
  const keyed = new Map(weeklyRows.map(row => [`${pkg.get(row.workPackageId.toLowerCase()) ?? 'unknown-package'}:${person.get(row.membershipId.toLowerCase()) ?? 'unknown-person'}`, row]));
  for (const row of oracle.rows) {
    const actual = keyed.get(row.key);
    for (const field of ['scope', 'plannedMinutes', 'actualMinutes', 'factRecorded', 'packageEstimateMinutes']) add(`row.${row.key}.${field}`, row[field], actual?.[field]);
  }
  add('row.unexpected', 0, [...keyed.keys()].filter(key => !oracle.rows.some(row => row.key === key)).length);
  const originals = weeklyRows.filter(row => row.scope === 'original'), baselines = new Map();
  for (const row of originals) if (row.packageBaselineId) baselines.set(row.packageBaselineId, row.packageEstimateMinutes);
  add('packages.teamKnownEstimateMinutes', oracle.packages.teamKnownEstimateMinutes, sum([...baselines.values()]));
  add('packages.unknownEstimateCount', oracle.packages.unknownEstimateCount, new Set(originals.filter(row => row.packageBaselineId === null).map(row => row.workPackageId)).size);
  for (const [key, count] of Object.entries(oracle.packages.sharedPackages)) {
    const shared = originals.filter(row => pkg.get(row.workPackageId.toLowerCase()) === key);
    add(`packages.${key}.originalRows`, count, shared.length); add(`packages.${key}.distinctBaselines`, 1, new Set(shared.map(row => row.packageBaselineId)).size);
  }
  const logs = weeklyRows.flatMap(row => row.workLogs), active = logs.filter(log => log.state === 'active');
  add('facts.activeSources', oracle.sourceCount, active.length);
  add('facts.recordedBeforeFreeze', 0, logs.filter(log => BigInt(log.changeSeq) <= BigInt(baseline.changeSeq)).length);
  const meetingRows = weeklyRows.filter(row => pkg.get(row.workPackageId.toLowerCase()) === MEETING.key);
  add('meeting.plannedMinutes', oracle.meeting.plannedMinutes, sum(meetingRows.map(row => row.plannedMinutes ?? 0)));
  add('meeting.actualMinutes', oracle.meeting.actualMinutes, sum(meetingRows.map(row => row.actualMinutes)));
  add('meeting.attendanceSources', oracle.meeting.sourceCount, meetingRows.flatMap(row => row.workLogs).filter(log => log.sourceKind === 'meeting_attendance' && log.state === 'active').length);
  add('meeting.packageEstimateMinutes', oracle.meeting.packageEstimateMinutes, new Set(meetingRows.map(row => row.packageEstimateMinutes)).size === 1 ? meetingRows[0].packageEstimateMinutes : 'inconsistent');
  const label = bucket => bucket.optionId === null ? UNCATEGORIZED : option.get(bucket.optionId.toLowerCase()) ?? 'unknown-option';
  function compareBuckets(prefix, expected, actual) {
    for (const [category, minutes] of Object.entries(expected)) add(`${prefix}.${category}`, minutes, actual.find(bucket => label(bucket) === category)?.minutes);
    add(`${prefix}.unexpectedBuckets`, 0, actual.filter(bucket => !(label(bucket) in expected)).length);
  }
  for (const field of ['totalActualMinutes', 'activeSourceCount', 'categorizedMinutes', 'uncategorizedMinutes']) add(`workType.team.${field}`, oracle.workTypes[field], workType[field]);
  compareBuckets('workType.team', oracle.workTypes.byCategory, workType.byCategory);
  for (const [key, expected] of Object.entries(oracle.workTypes.byPerson)) {
    const entry = workType.byPerson.find(item => person.get(item.membershipId.toLowerCase()) === key);
    add(`workType.${key}.totalActualMinutes`, expected.totalActualMinutes, entry?.totalActualMinutes); add(`workType.${key}.activeSourceCount`, expected.activeSourceCount, entry?.activeSourceCount);
    compareBuckets(`workType.${key}`, expected.byCategory, entry?.byCategory ?? []);
  }
  add('crossReport.totalActualMinutes', weekly.summary.totalActualMinutes, workType.totalActualMinutes);
  const failures = checks.filter(item => !item.ok).map(({ name, expected, actual }) => ({ name, expected, actual }));
  return { passed: checks.length - failures.length, failed: failures.length, failures };
}

export function totalsTable(oracle, observed, ids) {
  const person = key => ids.memberships[key]?.toLowerCase();
  const weeklyFor = key => observed.weekly.byPerson.find(item => item.membershipId.toLowerCase() === person(key))?.summary;
  return { team: { plannedExpected: oracle.team.knownPlannedMinutes, plannedActual: observed.weekly.summary.knownPlannedMinutes, originalFactExpected: oracle.team.actualMinutes, originalFactActual: observed.weekly.summary.actualMinutes,
      totalFactExpected: oracle.team.totalActualMinutes, totalFactActual: observed.weekly.summary.totalActualMinutes, workTypeTotalActual: observed.workType.totalActualMinutes,
      coverageExpected: `${oracle.team.recordedItemCount}/${oracle.team.totalItemCount}`, coverageActual: `${observed.weekly.summary.factCoverage.recordedItemCount}/${observed.weekly.summary.factCoverage.totalItemCount}` },
    byPerson: Object.fromEntries(PEOPLE.map(item => [item.label, { plannedExpected: oracle.byPerson[item.key].knownPlannedMinutes, plannedActual: weeklyFor(item.key)?.knownPlannedMinutes ?? null,
      totalFactExpected: oracle.byPerson[item.key].totalActualMinutes, totalFactActual: weeklyFor(item.key)?.totalActualMinutes ?? null }])) };
}

export function assertBeforeCutoff(state, now = Date.now()) {
  if (state.commands?.freeze?.response) return;
  if (now >= Date.parse(DEMO.cutoffAt) - CUTOFF_MARGIN_MS) throw new DemoError('The fixed demo week cutoff has passed or is within one hour; an automatic cutoff freeze would replace the explicit plan freeze. No request was sent.');
}

/** Safe operator-facing failure text: API status/code or a controlled message only, never connection strings. */
export function describeError(error) {
  if (error instanceof DemoError) return error.message;
  if (typeof error?.message === 'string' && /^API returned \d{3} \([A-Za-z0-9_ ]+\)\. Preserve the manifest and retry the original operation\.$/.test(error.message)) return error.message;
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code)) return `${error.name ?? 'Error'} (${error.code})`;
  return typeof error?.name === 'string' ? error.name : 'Error';
}

export function taskBody(task, refs) {
  const { projectId, sectionId, statusId, membership, tagId, parentId, position } = refs;
  const participants = (task.participants ?? [task.person]).map(membership);
  return { projectId, sectionId, title: task.title, statusId, responsibleMembershipId: membership(task.person), participantMembershipIds: participants,
    description: 'Synthetic demo task loosely modelled on a team planning board. It does not describe real people or customer work.',
    priority: task.priority, tagIds: task.tags.map(tagId), startDate: dateAt(DEMO.week, Math.max(0, task.due - 2)), dueDate: dateAt(DEMO.week, task.due), position,
    ...(task.parent ? { parentTaskId: parentId } : { estimateMinutes: task.estimate }) };
}

function summary() {
  const oracle = expectedOracle(), byLabel = map => Object.fromEntries(PEOPLE.map(person => [person.label, map[person.key]]));
  return { mode: 'dry-run — no network or database access', workspaceId: WORKSPACE, workspace: DEMO.workspaceName, project: DEMO.projectName,
    week: DEMO.week, period: DEMO.periodName, timezone: DEMO.timezone, cutoffAt: DEMO.cutoffAt,
    people: PEOPLE.map(person => ({ persona: person.label, section: sectionName(person), existingActor: person.fixtureName, role: person.role, membershipId: stableId(`membership:${person.key}`) })),
    counts: { rootTasks: TASKS.filter(task => !task.parent).length, detailSubtasks: TASKS.filter(task => task.parent).length, lateTasks: LATE_TASKS.length, meetings: 1,
      personalPlans: PLANS.length + MEETING.attendees.length + LATE_PLANS.length, facts: FACTS.length, attendancePostings: MEETING.attendees.length, tags: TAGS.length, workTypes: CATEGORIES.length },
    hours: { teamPackageEstimates: hm(oracle.packages.teamKnownEstimateMinutes), personalPlans: hm(oracle.team.knownPlannedMinutes),
      originalFacts: hm(oracle.team.actualMinutes), allFacts: hm(oracle.team.totalActualMinutes), meetingFacts: hm(oracle.meeting.actualMinutes) },
    expected: { team: oracle.team, byPerson: byLabel(oracle.byPerson), workTypes: { ...oracle.workTypes, byPerson: byLabel(oracle.workTypes.byPerson) },
      meeting: { ...oracle.meeting, byPerson: byLabel(oracle.meeting.byPerson) }, packages: oracle.packages, weeklyRows: oracle.rows.length },
    workflow: ['additive workspace and five memberships through the database seed seam', 'project, sections, tags, Work type field, columns and category binding through API commands',
      'tasks, detail subtask, values and personal plans', 'meeting with preview/apply personal plans', 'preview and explicit manual project freeze',
      'late added-scope task and plan after the freeze', 'manual facts and meeting attendance', 'pinned weekly and work-type reports',
      'original row preservation check', 'oracle verification of the pinned reports'],
    manifest: '.local/demo/asana-v1.json (private 0600; exact command bodies/keys written before requests)',
    execute: 'node scripts/bootstrap-asana-demo.mjs --execute', verify: 'node scripts/bootstrap-asana-demo.mjs --verify' };
}

async function getAllPages(C, path, responseSchema) {
  const items = []; let cursor = null;
  for (let page = 0; page < 20; page++) {
    const response = await globalThis.fetch(`${APP}${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET', redirect: 'error',
      headers: { accept: 'application/json', origin: APP }, signal: globalThis.AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok) throw new DemoError(`API returned ${response.status} (${typeof result.error?.code === 'string' ? result.error.code : 'controlled response'}) while reading report rows.`);
    const parsed = C[responseSchema].parse(result);
    items.push(...parsed.data); cursor = parsed.meta.nextCursor ?? null;
    if (!cursor) return items;
  }
  throw new DemoError('Report rows exceeded the bounded page count.');
}

async function connect() {
  const C = await import('@workloom/contracts');
  const api = (method, path, body, responseSchema, operationKey, serializedBody) => requestDemoJson({ app: APP, method, path, body, responseSchema, contracts: C, operationKey, serializedBody });
  phase = 'readiness and synthetic identity';
  const ready = await globalThis.fetch(`${APP}/healthz/ready`, { redirect: 'error', signal: globalThis.AbortSignal.timeout(5000) }).then(response => response.json());
  if (ready.status !== 'ok' || ready.checks?.database !== 'ok' || ready.checks?.schema !== 'ok') throw new DemoError('Existing app/database are not ready.');
  const me = await api('GET', '/api/v1/me', null, 'meResponseSchema');
  if (me.actor.id !== PEOPLE[0].userId) throw new DemoError('Default API actor must be the existing Synthetic Owner.');
  return { C, api };
}

async function verify(state, C, api) {
  phase = 'oracle verification of pinned reports';
  const { reports, ids } = state;
  const observed = { baseline: await api('GET', `${BASE}/baselines/${reports.baselineId}`, null, 'planBaselineResponseSchema'),
    weekly: await api('GET', `${BASE}/report-runs/${reports.weeklyRunId}`, null, 'weeklyPlanFactReportRunResponseSchema'),
    weeklyRows: await getAllPages(C, `${BASE}/report-runs/${reports.weeklyRunId}/rows`, 'weeklyPlanFactRowListResponseSchema'),
    workType: await api('GET', `${BASE}/work-type-report-runs/${reports.workTypeRunId}`, null, 'workTypeReportRunResponseSchema') };
  const oracle = expectedOracle();
  return { result: compareReports(oracle, observed, ids), totals: totalsTable(oracle, observed, ids) };
}

function readState() {
  const state = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (state.version !== 1 || state.workspaceId !== WORKSPACE || state.fixtureDigest !== digest(FIXTURE) || !state.commands) throw new DemoError('Manifest identity/fixture differs; preserve it and review before continuing.');
  return state;
}

async function execute() {
  phase = 'local configuration';
  const env = { ...parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')), ...process.env };
  validateLocalEnvironment(env);
  const { DEMO_USERS, DEMO_MEMBERSHIPS, createDatabase, schema } = await import('@workloom/db');
  const { eq, inArray } = await import('drizzle-orm');
  for (const person of PEOPLE) {
    const fixture = DEMO_USERS.find(user => user.id === person.userId), role = DEMO_MEMBERSHIPS.find(member => member.workspaceId === OLD_WORKSPACE && member.userId === person.userId)?.role;
    if (!fixture || fixture.displayName !== person.fixtureName || role !== person.role) throw new DemoError('Synthetic actor fixtures differ from this demo; refusing to continue.');
  }
  const members = PEOPLE.map(person => ({ id: stableId(`membership:${person.key}`), workspaceId: WORKSPACE, userId: person.userId, role: person.role }));
  const membership = key => members[PEOPLE.findIndex(person => person.key === key)].id;
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const existed = existsSync(MANIFEST);
  const state = existed ? readState() : { version: 1, workspaceId: WORKSPACE, fixtureDigest: digest(FIXTURE), week: DEMO.week, startedAt: new Date().toISOString(), commands: {} };
  assertBeforeCutoff(state);
  function save() { writePrivateJson(MANIFEST, state); }
  const { C, api } = await connect();
  const journal = createCommandJournal({ contracts: C, state, persist: save, send: api, basePath: BASE, operationId: label => stableId(`operation:${label}`) });
  async function command(label, ...args) { phase = label; return journal(label, ...args); }
  const db = createDatabase(env.DATABASE_URL, { requireLoopback: true, maxConnections: 1, applicationName: 'workloom-additive-asana-demo' });
  try {
    async function preservation(original) {
      return db.sql.begin('isolation level repeatable read read only', async sql => {
        await sql`SET LOCAL statement_timeout = '15s'`;
        await sql`SET LOCAL lock_timeout = '3s'`;
        await sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`;
        await sql`SET LOCAL TIME ZONE 'UTC'`;
        const tables = original ? Object.entries(original).map(([name, item]) => ({ name, primary_keys: item.primaryKeys })) : await sql`
          SELECT c.relname AS name, array_agg(a.attname ORDER BY k.ordinality) AS primary_keys
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
          JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality) ON true
          JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
          WHERE n.nspname='public' AND c.relkind='r' GROUP BY c.relname ORDER BY c.relname`;
        if (!tables.length) throw new DemoError('Original public table catalog is empty.');
        const proof = {};
        for (const table of tables) {
          if (!/^[a-z_][a-z0-9_]*$/.test(table.name) || !Array.isArray(table.primary_keys) || !table.primary_keys.length) throw new DemoError('Unsupported preservation table/key shape.');
          const rows = await sql.unsafe(`SELECT to_jsonb(t) AS row FROM public."${table.name}" t`);
          const key = row => JSON.stringify(table.primary_keys.map(name => row[name]));
          const originalKeys = original ? new Set(original[table.name].rowKeys) : null;
          const selected = rows.map(result => result.row).filter(row => !originalKeys || originalKeys.has(key(row))).sort((a, b) => key(a).localeCompare(key(b)));
          proof[table.name] = { primaryKeys: table.primary_keys, rowKeys: selected.map(key), count: selected.length, digest: digest(selected) };
        }
        return proof;
      });
    }
    phase = 'original data snapshot';
    if (!state.preservation) { state.preservation = await preservation(); save(); }
    phase = 'additive workspace/membership seed transaction';
    await db.db.transaction(async tx => {
      const users = await tx.select().from(schema.users).where(inArray(schema.users.id, PEOPLE.map(person => person.userId)));
      if (PEOPLE.some(person => !users.some(user => user.id === person.userId && user.kind === 'fixture' && user.displayName === person.fixtureName))) throw new DemoError('Existing synthetic actor fixtures differ; refusing to overwrite them.');
      const existing = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, WORKSPACE));
      if (existing.length && !existed) throw new DemoError('Demo workspace exists without its command manifest; refusing duplicate setup.');
      if (!existing.length) await tx.insert(schema.workspaces).values({ id: WORKSPACE, name: DEMO.workspaceName, timezone: DEMO.timezone, weekStart: 1 }).onConflictDoNothing();
      const current = (await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, WORKSPACE)))[0];
      if (!current || current.name !== DEMO.workspaceName || current.timezone !== DEMO.timezone || current.weekStart !== 1) throw new DemoError('Dedicated workspace fixture drift; refusing to alter it.');
      await tx.insert(schema.memberships).values(members).onConflictDoNothing();
      const currentMembers = await tx.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, WORKSPACE));
      if (currentMembers.length !== members.length || members.some(member => !currentMembers.some(row => row.id === member.id && row.userId === member.userId && row.role === member.role && row.state === 'active'))) throw new DemoError('Dedicated memberships differ; refusing to alter them.');
    });
    state.bootstrapCompletedAt ??= new Date().toISOString(); save();

    const project = await command('project', 'POST', `${BASE}/projects`, { name: DEMO.projectName }, 'createProjectInputSchema', 'projectResponseSchema');
    const statuses = await api('GET', `${BASE}/projects/${project.id}/statuses`, null, 'taskStatusListResponseSchema');
    if (statuses.some(status => /[А-Яа-яЁё]/.test(status.name))) throw new DemoError('New project status template is not English yet; wait for the approved API build/restart.');
    const status = group => statuses.find(item => item.group === group).id;
    const rituals = await command('section:rituals', 'POST', `${BASE}/projects/${project.id}/sections`, { name: 'Team rituals', position: 0 }, 'createSectionInputSchema', 'sectionResponseSchema');
    const sections = {};
    for (const [index, person] of PEOPLE.entries()) sections[person.key] = await command(`section:${person.key}`, 'POST', `${BASE}/projects/${project.id}/sections`, { name: sectionName(person), position: index + 1 }, 'createSectionInputSchema', 'sectionResponseSchema');
    const tags = {};
    for (const tag of TAGS) tags[tag.key] = await command(`tag:${tag.key}`, 'POST', `${BASE}/tags`, { name: tag.name, color: tag.color }, 'createTagInputSchema', 'tagResponseSchema');
    const field = await command('field:work-type', 'POST', `${BASE}/fields`, { projectId: project.id, name: 'Work type', type: 'single_select', options: CATEGORIES }, 'createTaskFieldInputSchema', 'taskFieldDefinitionResponseSchema');
    const optionId = name => field.options.find(item => item.name === name).id;
    const columns = await api('GET', `${BASE}/projects/${project.id}/columns`, null, 'projectColumnsResponseSchema');
    await command('columns', 'PATCH', `${BASE}/projects/${project.id}/columns`, { expectedRevision: columns.revision, columns: [{ fieldId: field.id, visible: true, width: 150, position: 0 }] }, 'updateProjectColumnsInputSchema', 'projectColumnsResponseSchema');
    const binding = await api('GET', `${BASE}/projects/${project.id}/work-category-binding`, null, 'projectWorkCategoryBindingResponseSchema');
    await command('category-binding', 'PATCH', `${BASE}/projects/${project.id}/work-category-binding`, { expectedRevision: binding.revision, fieldId: field.id }, 'updateProjectWorkCategoryBindingInputSchema', 'projectWorkCategoryBindingResponseSchema');
    const tasks = {};
    async function createTask(task, position) {
      const parent = task.parent ? tasks[task.parent] : null;
      tasks[task.key] = await command(`task:${task.key}`, 'POST', `${BASE}/tasks`, taskBody(task, { projectId: project.id, sectionId: sections[parent ? TASKS.find(item => item.key === task.parent).person : task.person].id,
        statusId: status(task.group), membership, tagId: key => tags[key].id, parentId: parent?.id, position }), 'createTaskInputSchema', 'taskResponseSchema');
      if (task.category) await command(`value:${task.key}`, 'PUT', `${BASE}/tasks/${tasks[task.key].id}/field-values/${field.id}`, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: optionId(task.category) } }, 'setTaskFieldValueInputSchema', 'taskFieldValueResponseSchema');
    }
    for (const [index, task] of TASKS.entries()) await createTask(task, index);
    const period = await command('period', 'POST', `${BASE}/periods`, { projectId: project.id, name: DEMO.periodName, localStart: DEMO.week, timezone: DEMO.timezone, cutoffAt: DEMO.cutoffAt, protectedFieldIds: [], protectEstimate: false }, 'createPlanningPeriodInputSchema', 'planningPeriodResponseSchema');
    const plan = (label, [task, person, minutes]) => command(label, 'POST', `${BASE}/periods/${period.id}/commitments`, { workPackageId: tasks[task].workPackageId, membershipId: membership(person), expectedAbsent: true, plannedMinutes: minutes, allocations: [{ taskId: tasks[task].id, minutes }] }, 'createPeriodCommitmentInputSchema', 'periodCommitmentResponseSchema');
    for (const item of PLANS) await plan(`plan:${item[0]}:${item[1]}`, item);
    const meeting = await command('meeting', 'POST', `${BASE}/projects/${project.id}/meetings`, { title: MEETING.title, statusId: status('done'), sectionId: rituals.id, plannedPeriodId: period.id,
      plannedStartAt: MEETING.plannedStartAt, timezone: DEMO.timezone, plannedDurationMinutes: MEETING.plannedDurationMinutes, organizerMembershipId: membership(MEETING.organizer), attendeeMembershipIds: MEETING.attendees.map(membership) }, 'createMeetingInputSchema', 'meetingCreationResponseSchema');
    await command('value:meeting', 'PUT', `${BASE}/tasks/${meeting.task.id}/field-values/${field.id}`, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: optionId(MEETING.category) } }, 'setTaskFieldValueInputSchema', 'taskFieldValueResponseSchema');
    await resumeOrPrepare(state.commands['meeting-plan'], async () => {
      phase = 'meeting plan preview';
      const preview = await api('POST', `${BASE}/tasks/${meeting.task.id}/meeting-plan-preview`, C.meetingPlanPreviewInputSchema.parse({ expectedMeetingRevision: meeting.meeting.revision, rows: MEETING.attendees.map(person => ({ membershipId: membership(person), plannedMinutes: MEETING.plannedMinutesPerPerson })) }), 'meetingPlanPreviewResponseSchema');
      return { expectedMeetingRevision: preview.meetingRevision, previewHash: preview.previewHash, rows: preview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) };
    }, body => command('meeting-plan', 'POST', `${BASE}/tasks/${meeting.task.id}/meeting-plan`, body, 'applyMeetingPlanInputSchema', 'meetingPlanResultResponseSchema'));
    const baseline = await resumeOrPrepare(state.commands.freeze, async () => {
      phase = 'project freeze preview';
      const preview = await api('POST', `${BASE}/periods/${period.id}/freeze-preview`, { scope: 'project' }, 'freezePreviewResponseSchema');
      return { scope: 'project', previewHash: preview.previewHash };
    }, body => command('freeze', 'POST', `${BASE}/periods/${period.id}/freeze`, body, 'freezePlanInputSchema', 'planBaselineResponseSchema'));
    // Everything below follows the genuine explicit freeze; the server classifies late work and plans.
    for (const [index, task] of LATE_TASKS.entries()) await createTask(task, TASKS.length + index);
    for (const item of LATE_PLANS) await plan(`late-plan:${item[0]}:${item[1]}`, item);
    for (const [task, person, minutes] of FACTS) await command(`fact:${task}:${person}`, 'PUT', `${BASE}/tasks/${tasks[task].id}/manual-period-work/${period.id}/${membership(person)}`, { expectedRevision: null, minutes, state: 'active', reason: 'Synthetic weekly demo fact' }, 'setManualPeriodWorkInputSchema', 'manualPeriodWorkLogResponseSchema');
    const actualMeeting = await command('meeting-actual', 'PATCH', `${BASE}/tasks/${meeting.task.id}/meeting`, { expectedMeetingRevision: meeting.meeting.revision, actualStartAt: MEETING.plannedStartAt, actualDurationMinutes: MEETING.actualDurationMinutes, summaryText: 'Synthetic planning call: reviewed the weekly board, confirmed owners and noted the merge regression.' }, 'updateMeetingInputSchema', 'meetingResponseSchema');
    await command('attendance', 'POST', `${BASE}/tasks/${meeting.task.id}/attendance/confirm`, { expectedMeetingRevision: actualMeeting.revision, periodId: period.id, rows: MEETING.attendees.map(person => {
      const row = meeting.attendances.find(item => item.membershipId === membership(person)), posted = MEETING.attendance[person];
      if (!row) throw new DemoError('Meeting attendance roster differs from the fixture.');
      return { attendanceId: row.id, expectedAttendanceRevision: row.revision, expectedWorkLogRevision: null, kind: 'confirm', status: posted.status, attributionBasis: 'actual_meeting', ...(posted.status === 'partial' ? { minutes: posted.minutes } : {}) };
    }) }, 'confirmAttendanceInputSchema', 'attendancePostingResponseSchema');
    const weekly = await command('weekly-report', 'POST', `${BASE}/report-runs`, { baselineId: baseline.id, membershipIds: [], knownEstimatesOnly: false }, 'createWeeklyPlanFactReportInputSchema', 'weeklyPlanFactReportRunResponseSchema');
    const workTypes = await command('work-type-report', 'POST', `${BASE}/work-type-report-runs`, { periodId: period.id, membershipIds: [] }, 'createWorkTypeReportRunInputSchema', 'workTypeReportRunResponseSchema');
    phase = 'original data preservation';
    const after = await preservation(state.preservation);
    if (JSON.stringify(after) !== JSON.stringify(state.preservation)) throw new DemoError('Original public table rows changed during the setup; review preservation evidence.');
    state.preservationVerifiedAt = new Date().toISOString(); state.completedAt ??= new Date().toISOString();
    const packages = Object.fromEntries([...TASKS, ...LATE_TASKS].filter(task => !task.parent).map(task => [task.key, tasks[task.key].workPackageId]));
    state.ids = { memberships: Object.fromEntries(PEOPLE.map(person => [person.key, membership(person.key)])), packages: { ...packages, [MEETING.key]: meeting.task.workPackageId }, options: Object.fromEntries(CATEGORIES.map(item => [item.name, optionId(item.name)])) };
    state.reports = { baselineId: baseline.id, weeklyRunId: weekly.id, workTypeRunId: workTypes.id };
    const projectLink = `${APP}/w/${WORKSPACE}/projects/${project.id}`, week = `${projectLink}/week?period=${period.id}`;
    state.links = { project: projectLink, myTasks: `${APP}/w/${WORKSPACE}/my-tasks`, week, report: `${week}&view=report&run=${weekly.id}`, workTypes: `${week}&view=work-types&typeRun=${workTypes.id}`,
      meeting: `${projectLink}?task=${meeting.task.id}`, sharedPackage: `${projectLink}?task=${tasks['persistent-views'].id}`, lateWork: `${projectLink}?task=${tasks[LATE_TASKS[0].key].id}` };
    save();
    return { state, C, api };
  } finally { await db.close(); }
}

async function report(state, C, api, log) {
  const { result, totals } = await verify(state, C, api);
  state.verification = { verifiedAt: new Date().toISOString(), passed: result.passed, failed: result.failed }; writePrivateJson(MANIFEST, state);
  log(JSON.stringify({ completedAt: state.completedAt, preservationVerifiedAt: state.preservationVerifiedAt, links: state.links, verification: result, totals }, null, 2));
  if (result.failed) throw new DemoError(`${result.failed} oracle check(s) failed; the pinned reports and product data were left unchanged.`);
}

export async function main(args = process.argv.slice(2), { log = console.log } = {}) {
  if (args.length > 1 || args.some(argument => !['--execute', '--dry-run', '--verify'].includes(argument))) throw new DemoError('Usage: node scripts/bootstrap-asana-demo.mjs [--dry-run|--execute|--verify]');
  if (!args[0] || args[0] === '--dry-run') { log(JSON.stringify(summary(), null, 2)); return; }
  if (args[0] === '--verify') {
    phase = 'manifest';
    if (!existsSync(MANIFEST)) throw new DemoError('No private manifest; run --execute first.');
    const state = readState();
    if (!state.completedAt || !state.reports || !state.ids) throw new DemoError('The setup has not completed; rerun --execute to resume it.');
    const { C, api } = await connect();
    return report(state, C, api, log);
  }
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const lock = join(DIRECTORY, 'setup.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new DemoError('Another demo setup holds .local/demo/setup.lock; inspect before removing a stale lock.'); }
  try { const { state, C, api } = await execute(); await report(state, C, api, log); } finally { rmSync(lock, { recursive: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(`Demo stopped during ${phase}: ${describeError(error).replace(/([^.])$/, '$1.')} No destructive recovery was attempted.`); process.exitCode = 1; });
}
