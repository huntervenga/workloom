#!/usr/bin/env node
// Additive synthetic showcase. Default is an offline dry-run; --execute is deliberate.
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
const MANIFEST = join(DIRECTORY, 'daily-v1.json');
const NAMESPACE = 'workloom-daily-showcase-v1';
const APP = 'http://127.0.0.1:4310';
const OLD_WORKSPACE = '5eed0000-0000-4000-8000-000000000201';
const WORKSPACE = stableId('workspace');
const BASE = `/api/v1/workspaces/${WORKSPACE}`;
let phase = 'argument validation';
class DemoError extends Error {}

export function stableId(label) {
  const raw = createHash('sha256').update(`${NAMESPACE}:${label}`).digest('hex').slice(0, 32).split('');
  raw[12] = '4'; raw[16] = '8';
  const value = raw.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function currentLocalDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Nicosia', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}
function monday(date) {
  const now = new Date(`${date}T00:00:00Z`); now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  return now.toISOString().slice(0, 10);
}
function dateAt(week, offset) { const date = new Date(`${week}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function digest(rows) { return createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }

export const TASKS = [
  { key: 'research', title: 'Validate the onboarding flow', person: 0, hours: 4, day: 0, group: 'done', type: 'Research', priority: 'high' },
  { key: 'brief', title: 'Approve the launch brief', person: 1, hours: 3, day: 1, group: 'done', type: 'Research', priority: 'medium' },
  { key: 'design', title: 'Polish the task workspace', person: 2, hours: 8, day: 4, group: 'in_progress', type: 'Delivery', priority: 'high' },
  { key: 'api', title: 'Connect the project API', person: 3, hours: 6, day: 4, group: 'in_progress', type: 'Delivery', priority: 'high' },
  { key: 'mobile', title: 'Review the mobile experience', person: 4, hours: 4, day: 4, group: 'todo', type: 'Quality', priority: 'medium' },
  { key: 'checks', title: 'Run the weekly workflow checks', person: 0, hours: 3, day: 4, group: 'todo', type: 'Quality', priority: 'high' },
  { key: 'guide', title: 'Write the quick-start guide', person: 1, hours: 2, day: 4, group: 'todo', type: 'Delivery', priority: 'medium' },
  { key: 'release', title: 'Prepare the launch checklist', person: 2, hours: 2, day: 6, group: 'todo', type: 'Quality', priority: 'medium' },
  { key: 'feedback', title: 'Collect the first team feedback', person: 3, hours: 2, day: 6, group: 'todo', type: 'Research', priority: 'low' },
  { key: 'metrics', title: 'Review adoption signals', person: 4, hours: 2, day: 6, group: 'todo', type: 'Research', priority: 'low' },
  { key: 'followup', title: 'Plan next week’s improvements', person: 0, hours: 1, day: 6, group: 'todo', type: 'Research', priority: 'low' },
];
const OPS_TASKS = [
  ['Confirm the team working agreement', 0, 'done'], ['Check the local backup record', 1, 'done'],
  ['Review shared meeting notes', 2, 'in_progress'], ['Refresh the support checklist', 3, 'todo'],
  ['Check the accessibility checklist', 4, 'todo'], ['Prepare next week’s planning', 0, 'todo'],
];

function summary(week) {
  return { mode: 'dry-run — no network or database access', workspaceId: WORKSPACE, workspace: 'Workloom Studio',
    actors: 'six existing allowlisted synthetic users; existing names and data unchanged', capturedLocalDate: currentLocalDate(), week, timezone: 'Asia/Nicosia',
    bootstrapRows: { workspace: { id: WORKSPACE, name: 'Workloom Studio', timezone: 'Asia/Nicosia', weekStart: 1 }, memberships: ['owner', 'admin', 'member', 'member', 'member', 'viewer'].map((role, index) => ({ id: stableId(`membership:${index}`), workspaceId: WORKSPACE, userId: `5eed0000-0000-4000-8000-00000000010${index + 1}`, role })) },
    projects: ['Product launch', 'Team operations'], tasks: TASKS.length + OPS_TASKS.length + 1,
    columns: ['Work type', 'Risk', 'Review link'], workflow: ['add workspace/memberships through the database seed seam', 'create projects/sections/tasks/fields/dependencies through API commands', 'create explicit weekly plans and shared meeting plan', 'preview and freeze the real current plan', 'record manual facts and meeting attendance', 'create pinned weekly/work-type reports', 'verify original user/workspace/project digests'],
    manifest: '.local/demo/daily-v1.json (private; exact command bodies/keys written before requests)', execute: 'node scripts/bootstrap-daily-demo.mjs --execute' };
}

async function execute(week) {
  phase = 'local configuration';
  const env = { ...parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')), ...process.env };
  validateLocalEnvironment(env);
  const C = await import('@workloom/contracts');
  const { createDatabase, schema, DEMO_USERS, DEMO_MEMBERSHIPS } = await import('@workloom/db');
  const { eq, inArray } = await import('drizzle-orm');
  const actors = DEMO_USERS.slice(0, 6);
  const members = actors.map((user, index) => ({ id: stableId(`membership:${index}`), workspaceId: WORKSPACE, userId: user.id,
    role: DEMO_MEMBERSHIPS.find(member => member.workspaceId === OLD_WORKSPACE && member.userId === user.id).role }));
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const existed = existsSync(MANIFEST);
  const state = existed ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { version: 1, workspaceId: WORKSPACE, capturedLocalDate: currentLocalDate(), timezone: 'Asia/Nicosia', week, startedAt: new Date().toISOString(), commands: {} };
  if (state.version !== 1 || state.workspaceId !== WORKSPACE || state.week !== week || !state.commands) throw new DemoError('Manifest identity/week differs; preserve it and review before continuing.');
  function save() { writePrivateJson(MANIFEST, state); }
  async function api(method, path, body, responseSchema, operationKey, serializedBody) {
    return requestDemoJson({ app: APP, method, path, body, responseSchema, contracts: C, operationKey, serializedBody });
  }
  const journal = createCommandJournal({ contracts: C, state, persist: save, send: api, basePath: BASE, operationId: label => stableId(`operation:${label}`) });
  async function command(label, ...args) { phase = label; return journal(label, ...args); }
  const db = createDatabase(env.DATABASE_URL, { requireLoopback: true, maxConnections: 1, applicationName: 'workloom-additive-daily-demo' });
  try {
    phase = 'readiness and synthetic identity';
    const ready = await globalThis.fetch(`${APP}/healthz/ready`, { redirect: 'error', signal: globalThis.AbortSignal.timeout(5000) }).then(response => response.json());
    if (ready.status !== 'ok' || ready.checks?.database !== 'ok' || ready.checks?.schema !== 'ok') throw new DemoError('Existing app/database are not ready.');
    const me = await api('GET', '/api/v1/me', null, 'meResponseSchema');
    if (me.actor.id !== actors[0].id) throw new DemoError('Default API actor must be the existing Synthetic Owner.');
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
    if (!state.preservation) { state.preservation = await preservation(); save(); }
    phase = 'additive workspace/membership seed transaction';
    await db.db.transaction(async tx => {
      const users = await tx.select().from(schema.users).where(inArray(schema.users.id, actors.map(actor => actor.id)));
      if (actors.some(actor => !users.some(user => user.id === actor.id && user.kind === 'fixture' && user.displayName === actor.displayName))) throw new DemoError('Existing synthetic actor fixtures differ; refusing to overwrite them.');
      const existing = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, WORKSPACE));
      if (existing.length && !existed) throw new DemoError('Demo workspace exists without its command manifest; refusing duplicate setup.');
      if (!existing.length) await tx.insert(schema.workspaces).values({ id: WORKSPACE, name: 'Workloom Studio', timezone: 'Asia/Nicosia', weekStart: 1 }).onConflictDoNothing();
      const current = (await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, WORKSPACE)))[0];
      if (!current || current.name !== 'Workloom Studio' || current.timezone !== 'Asia/Nicosia' || current.weekStart !== 1) throw new DemoError('Dedicated workspace fixture drift; refusing to alter it.');
      await tx.insert(schema.memberships).values(members).onConflictDoNothing();
      const currentMembers = await tx.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, WORKSPACE));
      if (currentMembers.length !== 6 || members.some(member => !currentMembers.some(row => row.id === member.id && row.userId === member.userId && row.role === member.role && row.state === 'active'))) throw new DemoError('Dedicated memberships differ; refusing to alter them.');
    });
    state.bootstrapCompletedAt ??= new Date().toISOString(); save();
    const projects = [];
    for (const [index, name] of ['Product launch', 'Team operations'].entries()) {
      const project = await command(`project:${index}`, 'POST', `${BASE}/projects`, { name }, 'createProjectInputSchema', 'projectResponseSchema');
      const statuses = await api('GET', `${BASE}/projects/${project.id}/statuses`, null, 'taskStatusListResponseSchema');
      if (statuses.some(status => /[А-Яа-яЁё]/.test(status.name))) throw new DemoError('New project status template is not English yet; wait for the approved API build/restart.');
      const sections = [];
      for (const [sectionIndex, section] of ['This week', 'Next up'].entries()) sections.push(await command(`section:${index}:${sectionIndex}`, 'POST', `${BASE}/projects/${project.id}/sections`, { name: section, position: sectionIndex }, 'createSectionInputSchema', 'sectionResponseSchema'));
      projects.push({ project, statuses, sections });
    }
    const main = projects[0]; const operations = projects[1];
    const fields = [];
    for (const [index, field] of [
      { name: 'Work type', type: 'single_select', options: [{ name: 'Research', color: '#8b5cf6' }, { name: 'Delivery', color: '#6366f1' }, { name: 'Quality', color: '#10b981' }, { name: 'Teamwork', color: '#0ea5e9' }] },
      { name: 'Risk', type: 'single_select', options: [{ name: 'On track', color: '#10b981' }, { name: 'Needs attention', color: '#f59e0b' }] },
      { name: 'Review link', type: 'url' },
    ].entries()) fields.push(await command(`field:${index}`, 'POST', `${BASE}/fields`, { projectId: main.project.id, ...field }, 'createTaskFieldInputSchema', 'taskFieldDefinitionResponseSchema'));
    const columnSettings = await api('GET', `${BASE}/projects/${main.project.id}/columns`, null, 'projectColumnsResponseSchema');
    await command('columns', 'PATCH', `${BASE}/projects/${main.project.id}/columns`, { expectedRevision: columnSettings.revision, columns: fields.map((field, index) => ({ fieldId: field.id, visible: index < 2, width: index === 0 ? 140 : 160, position: index })) }, 'updateProjectColumnsInputSchema', 'projectColumnsResponseSchema');
    const binding = await api('GET', `${BASE}/projects/${main.project.id}/work-category-binding`, null, 'projectWorkCategoryBindingResponseSchema');
    await command('category-binding', 'PATCH', `${BASE}/projects/${main.project.id}/work-category-binding`, { expectedRevision: binding.revision, fieldId: fields[0].id }, 'updateProjectWorkCategoryBindingInputSchema', 'projectWorkCategoryBindingResponseSchema');
    const tasks = [];
    for (const [index, item] of TASKS.entries()) {
      const member = members[item.person]; const second = members[(item.person + 1) % 5];
      const task = await command(`task:${item.key}`, 'POST', `${BASE}/tasks`, { projectId: main.project.id, sectionId: main.sections[index < 7 ? 0 : 1].id,
        title: item.title, description: 'Synthetic team example. Use this task to explore Workloom; it does not describe real customer work.',
        statusId: main.statuses.find(status => status.group === item.group).id, responsibleMembershipId: member.id,
        participantMembershipIds: [member.id, second.id], estimateMinutes: item.hours * 60, priority: item.priority,
        startDate: dateAt(week, Math.max(0, item.day - 1)), dueDate: dateAt(week, item.day), position: index }, 'createTaskInputSchema', 'taskResponseSchema');
      tasks.push(task);
      for (const [fieldIndex, name] of [[0, item.type], [1, index === 3 ? 'Needs attention' : 'On track']]) {
        const field = fields[fieldIndex];
        await command(`value:${item.key}:${fieldIndex}`, 'PUT', `${BASE}/tasks/${task.id}/field-values/${field.id}`, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: field.options.find(option => option.name === name).id } }, 'setTaskFieldValueInputSchema', 'taskFieldValueResponseSchema');
      }
    }
    for (const index of [0, 6]) await command(`review-link:${index}`, 'PUT', `${BASE}/tasks/${tasks[index].id}/field-values/${fields[2].id}`, { expectedRevision: 0, expectedDefinitionRevision: fields[2].revision, value: { type: 'url', value: `https://example.test/synthetic-launch/review-${index + 1}` } }, 'setTaskFieldValueInputSchema', 'taskFieldValueResponseSchema');
    for (const [index, [title, person, group]] of OPS_TASKS.entries()) await command(`ops-task:${index}`, 'POST', `${BASE}/tasks`, { projectId: operations.project.id, sectionId: operations.sections[index < 3 ? 0 : 1].id, title,
      description: 'Synthetic operations example; no real customer or production action is implied.', statusId: operations.statuses.find(status => status.group === group).id,
      responsibleMembershipId: members[person].id, participantMembershipIds: [members[person].id], estimateMinutes: 60, dueDate: dateAt(week, 4), priority: 'medium', position: index }, 'createTaskInputSchema', 'taskResponseSchema');
    for (const [index, [before, after]] of [[0, 2], [1, 3], [2, 6]].entries()) await command(`dependency:${index}`, 'POST', `${BASE}/dependencies`, { predecessorTaskId: tasks[before].id, successorTaskId: tasks[after].id, type: 'finish_to_start', expectedAbsent: true }, 'createTaskDependencyInputSchema', 'taskDependencyResponseSchema');
    const period = await command('period', 'POST', `${BASE}/periods`, { projectId: main.project.id, name: 'Launch week', localStart: week, timezone: 'Asia/Nicosia', cutoffAt: `${dateAt(week, 7)}T00:00:00.000Z`, protectedFieldIds: [], protectEstimate: false }, 'createPlanningPeriodInputSchema', 'planningPeriodResponseSchema');
    for (const [index, task] of tasks.entries()) await command(`plan:${index}`, 'POST', `${BASE}/periods/${period.id}/commitments`, { workPackageId: task.workPackageId, membershipId: members[TASKS[index].person].id, expectedAbsent: true, plannedMinutes: TASKS[index].hours * 60, allocations: [{ taskId: task.id, minutes: TASKS[index].hours * 60 }] }, 'createPeriodCommitmentInputSchema', 'periodCommitmentResponseSchema');
    const meeting = await command('meeting', 'POST', `${BASE}/projects/${main.project.id}/meetings`, { title: 'Launch team check-in', statusId: main.statuses.find(status => status.group === 'todo').id, sectionId: main.sections[0].id, plannedPeriodId: period.id,
      plannedStartAt: `${dateAt(week, 3)}T13:00:00.000Z`, timezone: 'Asia/Nicosia', plannedDurationMinutes: 30, organizerMembershipId: members[0].id, attendeeMembershipIds: members.slice(0, 5).map(member => member.id) }, 'createMeetingInputSchema', 'meetingCreationResponseSchema');
    await command('meeting-category', 'PUT', `${BASE}/tasks/${meeting.task.id}/field-values/${fields[0].id}`, { expectedRevision: 0, expectedDefinitionRevision: fields[0].revision, value: { type: 'single_select', value: fields[0].options.find(option => option.name === 'Teamwork').id } }, 'setTaskFieldValueInputSchema', 'taskFieldValueResponseSchema');
    await resumeOrPrepare(state.commands['meeting-plan'], async () => {
      phase = 'meeting plan preview';
      const rows = members.slice(0, 5).map(member => ({ membershipId: member.id, plannedMinutes: 30 }));
      const preview = await api('POST', `${BASE}/tasks/${meeting.task.id}/meeting-plan-preview`, C.meetingPlanPreviewInputSchema.parse({ expectedMeetingRevision: meeting.meeting.revision, rows }), 'meetingPlanPreviewResponseSchema');
      return { expectedMeetingRevision: preview.meetingRevision, previewHash: preview.previewHash, rows: preview.rows.map(row => ({ membershipId: row.membershipId, plannedMinutes: row.plannedMinutes, expectedCommitmentRevision: row.expectedCommitmentRevision })) };
    }, body => command('meeting-plan', 'POST', `${BASE}/tasks/${meeting.task.id}/meeting-plan`, body, 'applyMeetingPlanInputSchema', 'meetingPlanResultResponseSchema'));
    const baseline = await resumeOrPrepare(state.commands.freeze, async () => {
      phase = 'project freeze preview';
      const preview = await api('POST', `${BASE}/periods/${period.id}/freeze-preview`, { scope: 'project' }, 'freezePreviewResponseSchema');
      return { scope: 'project', previewHash: preview.previewHash };
    }, body => command('freeze', 'POST', `${BASE}/periods/${period.id}/freeze`, body, 'freezePlanInputSchema', 'planBaselineResponseSchema'));
    // Facts follow the genuine explicit freeze; no original estimate or baseline timestamp is invented.
    for (const [index, minutes] of [[0, 225], [1, 180], [2, 330], [3, 270], [4, 0], [5, 90], [6, 45]]) await command(`fact:${index}`, 'PUT', `${BASE}/tasks/${tasks[index].id}/manual-period-work/${period.id}/${members[TASKS[index].person].id}`, { expectedRevision: null, minutes, state: 'active', reason: 'Synthetic weekly example' }, 'setManualPeriodWorkInputSchema', 'manualPeriodWorkLogResponseSchema');
    const actualMeeting = await command('meeting-actual', 'PATCH', `${BASE}/tasks/${meeting.task.id}/meeting`, { expectedMeetingRevision: meeting.meeting.revision, actualStartAt: `${dateAt(week, 3)}T13:00:00.000Z`, actualDurationMinutes: 25, summaryText: 'Synthetic check-in: reviewed progress, noted the API risk, and agreed the next review.' }, 'updateMeetingInputSchema', 'meetingResponseSchema');
    await command('attendance', 'POST', `${BASE}/tasks/${meeting.task.id}/attendance/confirm`, { expectedMeetingRevision: actualMeeting.revision, periodId: period.id, rows: meeting.attendances.map((row, index) => ({ attendanceId: row.id, expectedAttendanceRevision: row.revision, expectedWorkLogRevision: null, kind: 'confirm', status: index === 4 ? 'partial' : 'present', attributionBasis: 'actual_meeting', ...(index === 4 ? { minutes: 15 } : {}) })) }, 'confirmAttendanceInputSchema', 'attendancePostingResponseSchema');
    const report = await command('weekly-report', 'POST', `${BASE}/report-runs`, { baselineId: baseline.id, membershipIds: [], knownEstimatesOnly: false }, 'createWeeklyPlanFactReportInputSchema', 'weeklyPlanFactReportRunResponseSchema');
    const categories = await command('work-type-report', 'POST', `${BASE}/work-type-report-runs`, { periodId: period.id, membershipIds: [] }, 'createWorkTypeReportRunInputSchema', 'workTypeReportRunResponseSchema');
    phase = 'original data preservation';
    const after = await preservation(state.preservation);
    if (JSON.stringify(after) !== JSON.stringify(state.preservation)) throw new DemoError('Original public table rows changed during the setup; review preservation evidence.');
    state.preservationVerifiedAt = new Date().toISOString(); state.completedAt ??= new Date().toISOString();
    state.links = { project: `${APP}/w/${WORKSPACE}/projects/${main.project.id}`, operations: `${APP}/w/${WORKSPACE}/projects/${operations.project.id}`,
      week: `${APP}/w/${WORKSPACE}/projects/${main.project.id}/week?period=${period.id}`, report: `${APP}/w/${WORKSPACE}/projects/${main.project.id}/week?period=${period.id}&view=report&run=${report.id}`,
      categories: `${APP}/w/${WORKSPACE}/projects/${main.project.id}/week?period=${period.id}&view=work-types&typeRun=${categories.id}` };
    state.summary = { weekly: report.summary, workTypes: { totalActualMinutes: categories.totalActualMinutes, byCategory: categories.byCategory }, taskCount: 18 }; save();
    console.log(JSON.stringify({ completedAt: state.completedAt, preservationVerifiedAt: state.preservationVerifiedAt, links: state.links, summary: state.summary }, null, 2));
  } finally { await db.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(argument => !['--execute', '--dry-run'].includes(argument)) || args.length > 1) throw new DemoError('Usage: node scripts/bootstrap-daily-demo.mjs [--dry-run|--execute]');
  let week = monday(currentLocalDate());
  if (existsSync(MANIFEST)) week = JSON.parse(readFileSync(MANIFEST, 'utf8')).week;
  if (args[0] !== '--execute') { console.log(JSON.stringify(summary(week), null, 2)); return; }
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const lock = join(DIRECTORY, 'setup.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new DemoError('Another demo setup holds .local/demo/setup.lock; inspect before removing a stale lock.'); }
  try { await execute(week); } finally { rmSync(lock, { recursive: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(`Demo stopped during ${phase}: ${error instanceof DemoError ? error.message : error.name}. No destructive recovery was attempted.`); process.exitCode = 1; });
}
