import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as C from '@workloom/contracts';
import { createCommandJournal, requestDemoJson, resumeOrPrepare } from '../../scripts/demo-command-journal.mjs';
import { writePrivateJson } from '../../scripts/private-json.mjs';
import { stableId, TASKS } from '../../scripts/bootstrap-daily-demo.mjs';

const workspaceId = stableId('workspace');
const projectId = stableId('test-project');
const memberId = stableId('test-member');
const taskId = stableId('test-task');
const stamp = '2026-10-16T08:00:00.000Z';
const project = { id: projectId, workspaceId, name: 'Product launch', revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp };
const basePath = `/api/v1/workspaces/${workspaceId}`;
const envelope = { data: project, meta: { requestId: 'offline-contract-smoke' } };

test('private JSON atomically replaces a complete file, keeps 0600, and preserves old file on serialization failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workloom-json-'));
  try {
    const path = join(directory, 'state.json');
    writePrivateJson(path, { version: 1, complete: true });
    const circular = {}; circular.self = circular;
    assert.throws(() => writePrivateJson(path, circular));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, complete: true });
    assert.deepEqual(readdirSync(directory), ['state.json']);
    writePrivateJson(path, { version: 2, complete: true });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2, complete: true });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native fetch boolean ok is accepted; redirect refusal and finite timeout are supplied', async () => {
  const result = await requestDemoJson({ app: 'http://127.0.0.1:4310', method: 'GET', path: `${basePath}/projects/${projectId}`, contracts: C, responseSchema: 'projectResponseSchema',
    fetcher: async (_url, options) => {
      assert.equal(options.redirect, 'error'); assert.equal(options.signal instanceof globalThis.AbortSignal, true);
      assert.equal(options.signal.aborted, false);
      return new globalThis.Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(result, project);
  await assert.rejects(requestDemoJson({ app: 'http://127.0.0.1:4310', method: 'GET', path: `${basePath}/projects/${projectId}`, contracts: C, responseSchema: 'projectResponseSchema', fetcher: async () => new globalThis.Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 }) }), /403.*FORBIDDEN/);
});

test('committed response loss reloads durable original serialized body/key and never creates a second operation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workloom-demo-journal-'));
  try {
    const path = join(directory, 'manifest.json');
    let state = { commands: {} }; const sent = [];
    let loseAcknowledgement = true;
    const persist = () => writePrivateJson(path, state);
    const send = async (_method, _path, body, _schema, key, serializedBody) => {
      // The disk write-ahead boundary must already exist at the exact moment a send begins.
      const disk = JSON.parse(readFileSync(path, 'utf8')).commands.project;
      assert.equal(disk.serializedBody, serializedBody); assert.equal(disk.operationKey, key);
      assert.deepEqual(JSON.parse(serializedBody), body); sent.push({ key, serializedBody });
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Committed, acknowledgement lost'); }
      return C.projectResponseSchema.parse(envelope).data;
    };
    const make = () => createCommandJournal({ contracts: C, state, persist, send, basePath, operationId: label => stableId(`operation:${label}`) });
    await assert.rejects(make()('project', 'POST', `${basePath}/projects`, { name: 'Product launch' }, 'createProjectInputSchema', 'projectResponseSchema'), /acknowledgement lost/);
    state = JSON.parse(readFileSync(path, 'utf8'));
    const result = await make()('project', 'POST', `${basePath}/projects`, { name: 'Different proposal must not replace unknown original' }, 'createProjectInputSchema', 'projectResponseSchema');
    assert.deepEqual(result, project); assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
    assert.equal(Object.keys(state.commands).length, 1);
    await make()('project', 'POST', `${basePath}/projects`, { name: 'Unused after acknowledgement' }, 'createProjectInputSchema', 'projectResponseSchema');
    assert.equal(sent.length, 2);
    await assert.rejects(make()('project', 'POST', `${basePath}/tasks`, {}, 'createTaskInputSchema', 'taskResponseSchema'), /manifest drift/);
    await assert.rejects(make()('outside', 'POST', '/api/v1/workspaces/other/projects', { name: 'No' }, 'createProjectInputSchema', 'projectResponseSchema'), /escaped/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('planned task, field, dependency, commitment, fact, freeze and attendance payload samples use real strict contracts', () => {
  for (const item of TASKS) C.createTaskInputSchema.parse({ projectId, title: item.title, statusId: stableId(item.group), responsibleMembershipId: memberId, participantMembershipIds: [memberId, stableId('second')], startDate: '2026-10-12', dueDate: '2026-10-16', estimateMinutes: item.hours * 60, priority: item.priority });
  C.createTaskFieldInputSchema.parse({ projectId, name: 'Work type', type: 'single_select', options: [{ name: 'Delivery', color: '#6366f1' }] });
  C.setTaskFieldValueInputSchema.parse({ expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'single_select', value: stableId('option') } });
  C.createTaskDependencyInputSchema.parse({ predecessorTaskId: taskId, successorTaskId: stableId('successor'), type: 'finish_to_start', expectedAbsent: true });
  C.createPlanningPeriodInputSchema.parse({ projectId, name: 'Launch week', localStart: '2026-10-12', timezone: 'Asia/Nicosia', cutoffAt: '2026-10-19T00:00:00.000Z', protectedFieldIds: [], protectEstimate: false });
  C.createPeriodCommitmentInputSchema.parse({ workPackageId: stableId('package'), membershipId: memberId, expectedAbsent: true, plannedMinutes: 120, allocations: [{ taskId, minutes: 120 }] });
  C.setManualPeriodWorkInputSchema.parse({ expectedRevision: null, minutes: 0, state: 'active', reason: 'Synthetic weekly example' });
  assert.equal(C.setManualPeriodWorkInputSchema.safeParse({ expectedRevision: 0, minutes: 0 }).success, false);
  C.freezePlanInputSchema.parse({ scope: 'project', previewHash: 'a'.repeat(64) });
  C.createMeetingInputSchema.parse({ title: 'Launch team check-in', statusId: stableId('todo'), plannedPeriodId: stableId('period'), plannedStartAt: '2026-10-15T13:00:00.000Z', timezone: 'Asia/Nicosia', plannedDurationMinutes: 30, organizerMembershipId: memberId, attendeeMembershipIds: [memberId] });
  C.meetingPlanPreviewInputSchema.parse({ expectedMeetingRevision: 1, rows: [{ membershipId: memberId, plannedMinutes: 30 }] });
  C.applyMeetingPlanInputSchema.parse({ expectedMeetingRevision: 1, previewHash: 'b'.repeat(64), rows: [{ membershipId: memberId, plannedMinutes: 30, expectedCommitmentRevision: null }] });
  C.updateMeetingInputSchema.parse({ expectedMeetingRevision: 1, actualStartAt: stamp, actualDurationMinutes: 25, summaryText: 'Synthetic check-in' });
  C.confirmAttendanceInputSchema.parse({ expectedMeetingRevision: 2, periodId: stableId('period'), rows: [
    { attendanceId: stableId('attendance:0'), expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: 'present', attributionBasis: 'actual_meeting' },
    { attendanceId: stableId('attendance:1'), expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: 'partial', attributionBasis: 'actual_meeting', minutes: 15 },
  ] });
  C.createWeeklyPlanFactReportInputSchema.parse({ baselineId: stableId('baseline'), membershipIds: [], knownEstimatesOnly: false });
  C.createWorkTypeReportRunInputSchema.parse({ periodId: stableId('period'), membershipIds: [] });
});


test('pending preview/apply command replays before any changed-source preview prerequisite', async () => {
  const body = { scope: 'project', previewHash: 'a'.repeat(64) };
  let prepared = 0;
  const result = await resumeOrPrepare({ body }, async () => { prepared++; throw new Error('Source already frozen after lost acknowledgement'); }, async replay => {
    assert.equal(replay, body); return 'original receipt';
  });
  assert.equal(result, 'original receipt'); assert.equal(prepared, 0);
  const first = await resumeOrPrepare(undefined, async () => { prepared++; return body; }, async proposed => proposed);
  assert.equal(first, body); assert.equal(prepared, 1);
});
