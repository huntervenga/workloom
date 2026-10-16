import * as contracts from '@workloom/contracts';
import { DEMO_USERS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type ReadinessProbe } from '@workloom/db';
import { DomainError, NOT_FOUND_MESSAGE, type AccessRepository, type CommandContext, type MeetingApplication } from '@workloom/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

// Recording ports prove transport only. Real PostgreSQL acceptance owns atomicity, roster,
// current capabilities, freeze, source uniqueness and attendance/category concurrency.
const HOST = '127.0.0.1:4310';
const ORIGIN = `http://${HOST}`;
const KEY = 'meeting-synthetic-command-key';
const CURSOR = 'opaque+meeting/cursor==';
const TS = '2026-10-16T09:00:00.000Z';
const W = FIXTURE_WORKSPACE_IDS.team;
const BASE = `/api/v1/workspaces/${W}`;
const ids = {
  project: '5eed0000-0000-4000-8000-000000000401', task: '5eed0000-0000-4000-8000-000000000405',
  status: '5eed0000-0000-4000-8000-000000000403', membership: '5eed0000-0000-4000-8000-000000000301',
  period: '5eed0000-0000-4000-8000-000000000601', package: '5eed0000-0000-4000-8000-000000000604',
  log: '5eed0000-0000-4000-8000-000000000609', logRevision: '5eed0000-0000-4000-8000-000000000610',
  meeting: '5eed0000-0000-4000-8000-000000000801', attendance: '5eed0000-0000-4000-8000-000000000802',
  history: '5eed0000-0000-4000-8000-000000000803',
};
const hash = 'a'.repeat(64);
const meeting = contracts.meetingSchema.parse({
  id: ids.meeting, workspaceId: W, projectId: ids.project, taskId: ids.task, workPackageId: ids.package,
  revision: 3, participantsRevision: 2, plannedPeriodId: ids.period, plannedStartAt: TS,
  timezone: 'Asia/Nicosia', plannedDurationMinutes: 60, organizerMembershipId: ids.membership,
  state: 'scheduled', actualStartAt: TS, actualDurationMinutes: 60, joinUrl: 'https://example.test/join',
  recordingUrl: null, summaryUrl: null, summaryText: null, scheduleFrozen: false,
  hasPostedAttendance: false, createdAt: TS, updatedAt: TS,
});
const task = contracts.taskSchema.parse({
  id: ids.task, meetingId: ids.meeting, workspaceId: W, projectId: ids.project, sectionId: null,
  parentTaskId: null, workPackageId: ids.package, workPackageRevision: 2, title: 'Synthetic meeting',
  description: '', statusId: ids.status, responsibleMembershipId: ids.membership,
  participants: [{ membershipId: ids.membership, role: 'assignee', active: true, revision: 1 }],
  participantsRevision: 2, dueDate: '2026-10-16', priority: 'none', tags: [], estimateMinutes: 60,
  revision: 1, position: 0, visibility: 'workspace', archivedAt: null, createdAt: TS, updatedAt: TS,
});
const manual = contracts.manualPeriodWorkLogSchema.parse({
  id: ids.log, workspaceId: W, projectId: ids.project, taskId: ids.task, workPackageId: ids.package,
  membershipId: ids.membership, periodId: ids.period, sourceKind: 'manual_period',
  sourceKey: `${ids.task}:${ids.membership}:${ids.period}`, precision: 'period', revision: 1,
  revisionId: ids.logRevision, minutes: 0, state: 'active', reason: null,
  actorUserId: FIXTURE_USER_IDS.owner, recordedAt: TS, changeSeq: '9007199254740993',
});
const occurrence = contracts.attendanceWorkLogSchema.parse({
  ...manual, id: '5eed0000-0000-4000-8000-000000000611', revisionId: '5eed0000-0000-4000-8000-000000000612', sourceKind: 'meeting_attendance', sourceKey: ids.attendance, precision: 'occurrence',
  meetingId: ids.meeting, attendanceId: ids.attendance, confirmedMeetingRevision: 3,
  minutes: 60, attribution: { basis: 'actual_meeting', plannedStartAt: TS, actualStartAt: TS },
});
const attendance = contracts.meetingAttendanceSchema.parse({
  id: ids.attendance, workspaceId: W, meetingId: ids.meeting, taskId: ids.task, membershipId: ids.membership,
  revision: 1, rosterActive: true, status: 'unknown', postingState: 'unconfirmed', minutes: null,
  confirmedMeetingRevision: null, workLog: null,
});
const confirmed = contracts.meetingAttendanceSchema.parse({ ...attendance, revision: 2, status: 'present', postingState: 'active', minutes: 60, confirmedMeetingRevision: 3, workLog: occurrence });
const posting = contracts.attendancePostingSchema.parse({ meeting: { ...meeting, hasPostedAttendance: true }, attendances: [confirmed] });
const creation = contracts.meetingCreationSchema.parse({ task, meeting, attendances: [attendance], planProposals: [{ membershipId: ids.membership, proposedMinutes: 60, workPackageId: ids.package, plannedPeriodId: ids.period }] });
const preview = contracts.meetingPlanPreviewSchema.parse({
  meetingId: ids.meeting, periodId: ids.period, meetingRevision: 3, participantsRevision: 2,
  workPackageRevision: 2, periodRevision: 1, previewHash: hash,
  rows: [{ membershipId: ids.membership, plannedMinutes: 60, commitment: null, expectedCommitmentRevision: null, allocations: [{ taskId: ids.task, minutes: 60 }], unallocatedMinutes: 0 }],
});
const planResult = contracts.meetingPlanResultSchema.parse({ meetingId: ids.meeting, periodId: ids.period, commitments: [] });
const history = contracts.attendanceHistorySchema.parse({
  id: ids.history, attendanceId: ids.attendance, revision: 2, rosterActive: true, status: 'present',
  postingState: 'active', minutes: 60, confirmedMeetingRevision: 3, actorUserId: FIXTURE_USER_IDS.owner,
  reason: null, recordedAt: TS, changeSeq: '9007199254740993', workLog: occurrence,
});

type Method = keyof MeetingApplication;
interface Call { method: Method; ctx: CommandContext; args: unknown[] }
const calls: Call[] = [];
const overrides = new Map<Method, () => unknown>();
function record<R>(method: Method, result: R) {
  return async (ctx: CommandContext, ...args: unknown[]): Promise<R> => {
    calls.push({ method, ctx, args });
    const override = overrides.get(method);
    return override ? override() as R : result;
  };
}
const page = <T>(item: T) => ({ items: [item], nextCursor: CURSOR });
const meetings: MeetingApplication = {
  listMeetings: record('listMeetings', page({ task, meeting })), createMeeting: record('createMeeting', creation),
  getMeeting: record('getMeeting', meeting), updateMeeting: record('updateMeeting', meeting),
  listAttendance: record('listAttendance', page(attendance)), confirmAttendance: record('confirmAttendance', posting),
  listRecordedWork: record('listRecordedWork', { items: [manual, occurrence], nextCursor: CURSOR }),
  listAttendanceHistory: record('listAttendanceHistory', page(history)),
  previewMeetingPlan: record('previewMeetingPlan', preview), applyMeetingPlan: record('applyMeetingPlan', planResult),
};
const repository: AccessRepository = {
  findUser: async id => DEMO_USERS.find(user => user.id === id) ?? null,
  findUsers: async userIds => DEMO_USERS.filter(user => userIds.includes(user.id)),
  listAccessibleWorkspaces: async () => [], findWorkspaceAccess: async () => null, listActiveMemberships: async () => [],
};
const readiness: ReadinessProbe = { check: async () => ({ ready: true, checks: { database: 'ok', schema: 'ok' } }) };
const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/unused' });
const meetingPath = `/tasks/${ids.task}/meeting`;
const confirmPath = `/tasks/${ids.task}/attendance/confirm`;
const previewPath = `/tasks/${ids.task}/meeting-plan-preview`;
const planPath = `/tasks/${ids.task}/meeting-plan`;
const createInput = { title: 'Synthetic meeting', statusId: ids.status, plannedPeriodId: ids.period, plannedStartAt: TS, timezone: 'Asia/Nicosia', plannedDurationMinutes: 60, organizerMembershipId: ids.membership, attendeeMembershipIds: [ids.membership] };
const attendanceRow = { attendanceId: ids.attendance, expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'confirm', status: 'present', attributionBasis: 'actual_meeting' };
const confirmInput = { expectedMeetingRevision: 3, periodId: ids.period, rows: [attendanceRow] };
const previewInput = { expectedMeetingRevision: 3, rows: [{ membershipId: ids.membership, plannedMinutes: 60 }] };
const applyInput = { expectedMeetingRevision: 3, previewHash: hash, rows: [{ membershipId: ids.membership, plannedMinutes: 60, expectedCommitmentRevision: null }] };
interface Route {
  method: 'GET' | 'POST' | 'PATCH'; path: string; query?: string; input?: Record<string, unknown>;
  service: Method; args: unknown[]; result: unknown; status?: number; paged?: boolean; readOnly?: boolean;
}
const routes: Route[] = [
  { method: 'GET', path: `/projects/${ids.project}/meetings`, query: `plannedPeriodId=${ids.period}`, service: 'listMeetings', args: [ids.project, { plannedPeriodId: ids.period, state: 'scheduled', limit: 50 }], result: [{ task, meeting }], paged: true },
  { method: 'POST', path: `/projects/${ids.project}/meetings`, input: createInput, service: 'createMeeting', args: [ids.project, createInput], result: creation, status: 201 },
  { method: 'GET', path: meetingPath, service: 'getMeeting', args: [ids.task], result: meeting },
  { method: 'PATCH', path: meetingPath, input: { expectedMeetingRevision: 3, actualDurationMinutes: 60 }, service: 'updateMeeting', args: [ids.task, { expectedMeetingRevision: 3, actualDurationMinutes: 60 }], result: meeting },
  { method: 'GET', path: `/tasks/${ids.task}/attendance`, service: 'listAttendance', args: [ids.task, { limit: 50 }], result: [attendance], paged: true },
  { method: 'POST', path: confirmPath, input: confirmInput, service: 'confirmAttendance', args: [ids.task, confirmInput], result: posting },
  { method: 'GET', path: '/recorded-work', query: `periodId=${ids.period}`, service: 'listRecordedWork', args: [{ periodId: ids.period, limit: 50 }], result: [manual, occurrence], paged: true },
  { method: 'GET', path: `/tasks/${ids.task}/attendance/${ids.attendance}/history`, service: 'listAttendanceHistory', args: [ids.task, ids.attendance, { limit: 50 }], result: [history], paged: true },
  { method: 'POST', path: previewPath, input: previewInput, service: 'previewMeetingPlan', args: [ids.task, previewInput], result: preview, readOnly: true },
  { method: 'POST', path: planPath, input: applyInput, service: 'applyMeetingPlan', args: [ids.task, applyInput], result: planResult },
];
const commands = routes.filter(route => route.method !== 'GET');
const mutations = commands.filter(route => !route.readOnly);
let app: FastifyInstance;
function url(route: Route) { return `${BASE}${route.path}${route.query ? `?${route.query}` : ''}`; }
function headers() { return { host: HOST, origin: ORIGIN, 'idempotency-key': KEY }; }
beforeAll(async () => { app = await createApp(config, { accessRepository: repository, readiness, meetingApplication: meetings, logger: false, webDistDir: null }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; overrides.clear(); });

describe('P3a meeting HTTP adapter', () => {
  it.each(routes)('$method $path uses parsed input, trusted actor and exact response', async route => {
    const response = await app.inject({ method: route.method, url: url(route), headers: { ...headers(), 'x-actor-id': FIXTURE_USER_IDS.outsider, 'x-request-id': 'spoofed' }, ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    const body = response.json();
    expect(body.data).toEqual(route.result);
    expect(body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(body.meta.requestId).not.toBe('spoofed');
    if (route.paged) expect(body.meta.nextCursor).toBe(CURSOR);
    else expect(body.meta).not.toHaveProperty('nextCursor');
    expect(calls).toEqual([{ method: route.service, args: route.args, ctx: {
      actor: { userId: FIXTURE_USER_IDS.owner, displayName: DEMO_USERS.find(user => user.id === FIXTURE_USER_IDS.owner)?.displayName, kind: 'fixture' },
      workspaceId: W, source: 'web', requestId: body.meta.requestId,
      ...(route.method === 'GET' || route.readOnly ? {} : { idempotencyKey: KEY }),
    } }]);
  });

  it.each(routes)('$method $path canonicalizes target and body/query UUIDs', async route => {
    const upper = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => id.toUpperCase());
    const response = await app.inject({ method: route.method, url: upper(url(route)), headers: headers(), ...(route.input ? { payload: JSON.parse(upper(JSON.stringify(route.input))) } : {}) });
    expect(response.statusCode).toBe(route.status ?? 200);
    expect(calls[0]?.args).toEqual(route.args);
    expect(calls[0]?.ctx.workspaceId).toBe(W);
  });

  it.each(mutations)('$path requires a valid command key', async route => {
    for (const key of [undefined, '', 'has space', 'x'.repeat(129)]) {
      const response = await app.inject({ method: route.method, url: url(route), headers: { host: HOST, origin: ORIGIN, ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(route.input ? { payload: route.input } : {}) });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it.each(commands)('$path rejects spoofed/server-owned body fields and write query parameters', async route => {
    for (const property of ['actor', 'workspaceId', 'meetingId', 'source', 'scheduleFrozen', 'hasPostedAttendance']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: headers(), payload: { ...route.input, [property]: 'spoofed' } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: route.method, url: `${url(route)}?actorId=${ids.membership}`, headers: headers(), ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each(commands)('$path requires a trusted Origin including the read-only preview', async route => {
    for (const origin of [undefined, 'https://foreign.example']) {
      expect((await app.inject({ method: route.method, url: url(route), headers: { host: HOST, 'idempotency-key': KEY, ...(origin ? { origin } : {}) }, ...(route.input ? { payload: route.input } : {}) })).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('treats plan preview as a strict read without an idempotency key', async () => {
    const response = await app.inject({ method: 'POST', url: BASE + previewPath, headers: { host: HOST, origin: ORIGIN }, payload: previewInput });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.ctx).not.toHaveProperty('idempotencyKey');
    expect(response.json().data.previewHash).toBe(hash);
  });

  it.each(routes.filter(route => route.paged))('$path preserves cursors and terminal pages', async route => {
    expect((await app.inject({ url: `${url(route)}${route.query ? '&' : '?'}limit=100&cursor=${encodeURIComponent(CURSOR)}`, headers: headers() })).statusCode).toBe(200);
    expect(calls[0]?.args.at(-1)).toEqual({ ...(route.args.at(-1) as object), limit: 100, cursor: CURSOR });
    overrides.set(route.service, () => ({ items: [], nextCursor: null }));
    expect((await app.inject({ url: url(route), headers: headers() })).json()).toMatchObject({ data: [], meta: { nextCursor: null } });
  });

  it('keeps explicit period/state/worker filters as data rather than identity', async () => {
    expect((await app.inject({ url: `${BASE}/projects/${ids.project}/meetings?plannedPeriodId=${ids.period}&state=all`, headers: headers() })).statusCode).toBe(200);
    expect(calls[0]?.args.at(-1)).toEqual({ plannedPeriodId: ids.period, state: 'all', limit: 50 });
    expect((await app.inject({ url: `${BASE}/recorded-work?periodId=${ids.period}&taskId=${ids.task}&membershipId=${ids.membership}`, headers: headers() })).statusCode).toBe(200);
    expect(calls[1]?.args).toEqual([{ periodId: ids.period, taskId: ids.task, membershipId: ids.membership, limit: 50 }]);
    expect(calls[1]?.ctx.actor.userId).toBe(FIXTURE_USER_IDS.owner);
  });

  it('rejects malformed/duplicate/unknown read queries and target IDs', async () => {
    const paths = [`/projects/${ids.project}/meetings`, `/projects/${ids.project}/meetings?plannedPeriodId=${ids.period}&plannedPeriodId=${ids.period}`, `/projects/${ids.project}/meetings?plannedPeriodId=${ids.period}&state=other`, '/recorded-work', `/recorded-work?periodId=${ids.period}&limit=0`, `/recorded-work?periodId=${ids.period}&limit=101`, `/recorded-work?periodId=${ids.period}&cursor=`, `/recorded-work?periodId=${ids.period}&actorId=${ids.membership}`, `/recorded-work?periodId=${ids.period}&membershipId=invalid`, meetingPath + '?periodId=' + ids.period, '/tasks/invalid/meeting', `/tasks/${ids.task}/attendance/invalid/history`];
    for (const path of paths) expect((await app.inject({ url: BASE + path, headers: headers() })).statusCode, path).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid create/update guards, times, roster and unsafe meeting links', async () => {
    const createCases = [{ ...createInput, plannedStartAt: '2026-11-01T01:30:00' }, { ...createInput, plannedStartAt: '2026-11-01T01:30:00-04:00' }, { ...createInput, timezone: '+03:00' }, { ...createInput, timezone: 'Not/AZone' }, { ...createInput, plannedDurationMinutes: 0 }, { ...createInput, attendeeMembershipIds: [ids.membership, ids.membership.toUpperCase()] }, { ...createInput, attendeeMembershipIds: [] }];
    for (const payload of createCases) expect((await app.inject({ method: 'POST', url: `${BASE}/projects/${ids.project}/meetings`, headers: headers(), payload })).statusCode).toBe(400);
    for (const joinUrl of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/hosts', 'mailto:user@example.test', 'invalid']) expect((await app.inject({ method: 'POST', url: `${BASE}/projects/${ids.project}/meetings`, headers: headers(), payload: { ...createInput, joinUrl } })).statusCode).toBe(400);
    const updateCases = [{ expectedMeetingRevision: 3 }, { expectedMeetingRevision: 0, state: 'cancelled' }, { expectedMeetingRevision: 3, plannedDurationMinutes: 90 }, { expectedMeetingRevision: 3, attendeeMembershipIds: [ids.membership] }, { expectedMeetingRevision: 3, recordingUrl: 'javascript:alert(1)' }, { expectedMeetingRevision: 3, plannedPeriodId: ids.period }];
    for (const payload of updateCases) expect((await app.inject({ method: 'PATCH', url: BASE + meetingPath, headers: headers(), payload })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('accepts bounded create input beyond16KiB with100 attendee IDs and escaped Unicode', async () => {
    const payload = { ...createInput, title: '界'.repeat(500), joinUrl: 'https://example.test/' + '界'.repeat(2000), attendeeMembershipIds: Array.from({ length: 100 }, (_, i) => `5eed0000-0000-4000-8000-${String(i).padStart(12, '0')}`) };
    const escaped = JSON.stringify(payload).replace(/[^ -~]/g, char => String.fromCharCode(92) + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(16 * 1024);
    expect((await app.inject({ method: 'POST', url: `${BASE}/projects/${ids.project}/meetings`, headers: { ...headers(), 'content-type': 'application/json' }, payload: escaped })).statusCode).toBe(201);
    expect(calls[0]?.args).toEqual([ids.project, payload]);
  });

  it('preserves explicit null details, roster guards and HTTP(S) links', async () => {
    const input = { expectedMeetingRevision: 3, expectedParticipantsRevision: 2, expectedWorkPackageRevision: 2, attendeeMembershipIds: [ids.membership], actualStartAt: null, actualDurationMinutes: null, summaryUrl: 'https://example.test/summary', recordingUrl: 'http://example.test/recording' };
    expect((await app.inject({ method: 'PATCH', url: BASE + meetingPath, headers: headers(), payload: input })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([ids.task, input]);
  });

  it('rejects invalid batch branches without partial service calls', async () => {
    const badRows = [{ ...attendanceRow, kind: 'confirm', status: 'unknown' }, { ...attendanceRow, status: 'partial', minutes: 0 }, { ...attendanceRow, status: 'partial' }, { ...attendanceRow, status: 'absent', minutes: 1 }, { ...attendanceRow, status: 'present', attributionBasis: 'planned_absence' }, { ...attendanceRow, expectedWorkLogRevision: 0 }, { attendanceId: ids.attendance, expectedAttendanceRevision: 1, expectedWorkLogRevision: null, kind: 'void', reason: '  ' }, { ...attendanceRow, membershipId: ids.membership }];
    for (const row of badRows) expect((await app.inject({ method: 'POST', url: BASE + confirmPath, headers: headers(), payload: { ...confirmInput, rows: [row] } })).statusCode).toBe(400);
    for (const rows of [[], [attendanceRow, { ...attendanceRow, attendanceId: ids.attendance.toUpperCase() }], Array.from({ length: 101 }, (_, i) => ({ ...attendanceRow, attendanceId: `5eed0000-0000-4000-8000-${String(i).padStart(12, '0')}` }))]) expect((await app.inject({ method: 'POST', url: BASE + confirmPath, headers: headers(), payload: { ...confirmInput, rows } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('passes planned absence zero and existing void head guards without inventing actual timing', async () => {
    const input = { expectedMeetingRevision: 3, periodId: ids.period, rows: [{ attendanceId: ids.attendance, expectedAttendanceRevision: 2, expectedWorkLogRevision: 8, kind: 'confirm', status: 'absent', attributionBasis: 'planned_absence', minutes: 0, reason: '  Cancelled without meeting  ' }] };
    const absentLog = { ...occurrence, minutes: 0, attribution: { basis: 'planned_absence', plannedStartAt: TS, actualStartAt: null } };
    overrides.set('confirmAttendance', () => ({ meeting: { ...meeting, state: 'cancelled', actualStartAt: null, actualDurationMinutes: null }, attendances: [{ ...confirmed, status: 'absent', minutes: 0, workLog: absentLog }] }));
    const response = await app.inject({ method: 'POST', url: BASE + confirmPath, headers: headers(), payload: input });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.attendances[0].workLog.attribution).toEqual(absentLog.attribution);
    expect(calls[0]?.args).toEqual([ids.task, { ...input, rows: [{ ...input.rows[0], reason: 'Cancelled without meeting' }] }]);
  });

  it('keeps plan null/zero and independent current commitment revisions', async () => {
    for (const plannedMinutes of [null, 0, 60]) {
      const input = { ...applyInput, rows: [{ membershipId: ids.membership, plannedMinutes, expectedCommitmentRevision: 7 }] };
      expect((await app.inject({ method: 'POST', url: BASE + planPath, headers: headers(), payload: input })).statusCode).toBe(200);
      expect(calls.at(-1)?.args).toEqual([ids.task, input]);
    }
    expect((await app.inject({ method: 'POST', url: BASE + planPath, headers: headers(), payload: { ...applyInput, previewHash: 'client snapshot' } })).statusCode).toBe(400);
  });

  it('accepts a strict100-row reasoned attendance batch beyond the global16KiB cap', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ attendanceId: `5eed0000-0000-4000-8000-${String(i).padStart(12, '0')}`, expectedAttendanceRevision: 2, expectedWorkLogRevision: 8, kind: 'void', reason: '界'.repeat(1000) }));
    const payload = { ...confirmInput, rows };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(16 * 1024);
    expect((await app.inject({ method: 'POST', url: BASE + confirmPath, headers: headers(), payload })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual([ids.task, payload]);
    const escaped = JSON.stringify(payload).replace(/[^ -~]/g, char => String.fromCharCode(92) + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(512 * 1024);
    expect((await app.inject({ method: 'POST', url: BASE + confirmPath, headers: { ...headers(), 'content-type': 'application/json' }, payload: escaped })).statusCode).toBe(200);
  });

  it('accepts bounded long meeting notes but keeps per-route and global caps', async () => {
    const payload = { expectedMeetingRevision: 3, summaryText: '界'.repeat(20000), joinUrl: 'https://example.test/' + '界'.repeat(2000), recordingUrl: 'https://example.test/' + '界'.repeat(2000), summaryUrl: 'https://example.test/' + '界'.repeat(2000) };
    const escaped = JSON.stringify(payload).replace(/[^ -~]/g, char => String.fromCharCode(92) + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(128 * 1024);
    expect((await app.inject({ method: 'PATCH', url: BASE + meetingPath, headers: { ...headers(), 'content-type': 'application/json' }, payload: escaped })).statusCode).toBe(200);
    calls.length = 0;
    for (const [method, path, size] of [['POST', confirmPath, 769 * 1024], ['PATCH', meetingPath, 257 * 1024], ['POST', `/projects/${ids.project}/meetings`, 65 * 1024]] as const) {
      const response = await app.inject({ method, url: BASE + path, headers: headers(), payload: { oversized: 'x'.repeat(size) } });
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    }
    expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
    expect((await app.inject({ method: 'POST', url: '/api/v1/dev/session', headers: { ...headers(), 'x-workloom-dev-tool': '1' }, payload: { oversized: 'x'.repeat(17 * 1024) } })).statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it.each(routes.filter(route => route.method === 'GET' || route.readOnly))('$path propagates current-access rejection without data', async route => {
    overrides.set(route.service, () => { throw new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE); });
    const response = await app.inject({ method: route.method, url: url(route), headers: headers(), ...(route.input ? { payload: route.input } : {}) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });

  it.each([['REVISION_CONFLICT', 409], ['PREVIEW_STALE', 409], ['FIELD_LOCKED', 409], ['IDEMPOTENCY_KEY_REUSED', 409], ['CAPABILITY_REQUIRED', 403], ['DOMAIN_VALIDATION_FAILED', 422]] as const)('propagates %s without retrying or partially returning attendance', async (code, status) => {
    overrides.set('confirmAttendance', () => { throw new DomainError(code, 'Safe meeting rejection'); });
    const response = await app.inject({ method: 'POST', url: BASE + confirmPath, headers: headers(), payload: confirmInput });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.json()).not.toHaveProperty('data');
    expect(calls).toHaveLength(1);
  });

  it('passes stable targets/keys on explicit retry and never caches across task IDs', async () => {
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: BASE + confirmPath, headers: headers(), payload: confirmInput })).statusCode).toBe(200);
    expect(calls[0]?.args).toEqual(calls[1]?.args);
    const other = '5eed0000-0000-4000-8000-000000000899';
    overrides.set('confirmAttendance', () => { throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Different target'); });
    expect((await app.inject({ method: 'POST', url: `${BASE}/tasks/${other}/attendance/confirm`, headers: headers(), payload: confirmInput })).statusCode).toBe(409);
    expect(calls.map(call => call.args[0])).toEqual([ids.task, ids.task, other]);
    expect(calls.map(call => call.ctx.idempotencyKey)).toEqual([KEY, KEY, KEY]);
  });

  it('keeps server meeting identity before any attendance and both source precisions intact', async () => {
    const created = await app.inject({ method: 'POST', url: `${BASE}/projects/${ids.project}/meetings`, headers: headers(), payload: createInput });
    expect(created.json().data.task.meetingId).toBe(ids.meeting);
    expect(created.json().data.attendances[0]).toMatchObject({ status: 'unknown', postingState: 'unconfirmed', workLog: null });
    const recorded = await app.inject({ url: `${BASE}/recorded-work?periodId=${ids.period}`, headers: headers() });
    expect(recorded.json().data.map((log: contracts.RecordedWorkLogDto) => [log.sourceKind, log.precision, log.periodId])).toEqual([['manual_period', 'period', ids.period], ['meeting_attendance', 'occurrence', ids.period]]);
  });

  it('redacts unexpected service errors and rejects invalid output attribution', async () => {
    overrides.set('getMeeting', () => { throw new Error('SQL password=never-return'); });
    const failed = await app.inject({ url: BASE + meetingPath, headers: headers() });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('never-return');
    overrides.set('listRecordedWork', () => ({ items: [{ ...occurrence, attribution: { basis: 'planned_absence', plannedStartAt: TS, actualStartAt: TS } }], nextCursor: null }));
    expect((await app.inject({ url: `${BASE}/recorded-work?periodId=${ids.period}`, headers: headers() })).statusCode).toBe(500);
  });

  it('does not register meeting routes in older apps without the new service', async () => {
    const older = await createApp(config, { accessRepository: repository, readiness, logger: false, webDistDir: null });
    try { expect((await older.inject({ url: BASE + meetingPath, headers: headers() })).statusCode).toBe(404); }
    finally { await older.close(); }
  });
});
