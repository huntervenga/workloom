// PRIVATE TEST DATA ONLY. Four non-login synthetic report members for a fresh real owner's empty workspace.
// No Auth accounts/invites are created. Root supplies the throwaway child URL explicitly and owns its lifecycle;
// this module starts nothing and never prints the connection string.
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import {
  freezePreviewResponseSchema, idSchema, manualPeriodWorkLogResponseSchema, membershipListResponseSchema,
  periodCommitmentResponseSchema, planBaselineResponseSchema, planningPeriodResponseSchema,
  projectResponseSchema, projectWorkCategoryBindingResponseSchema, taskFieldDefinitionResponseSchema,
  taskFieldValueResponseSchema, taskResponseSchema, taskStatusListResponseSchema, workspaceListResponseSchema,
  type ManualPeriodWorkLogDto, type MembershipDto, type TaskDto,
} from '@workloom/contracts';
import type { FakeSharedAuth } from './fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './private-membership-fixture.js';

export const REPORT_APP = 'http://127.0.0.1:49318';
type Parser<T> = { parse(value: unknown): T };

export const REPORT_MEMBER_NAMES = ['Blair report member', 'Casey report member', 'Devon report member', 'Ellis report member'] as const;
export type ReportMemberName = typeof REPORT_MEMBER_NAMES[number];
export interface ReportSyntheticMember { id: string; userId: string; displayName: ReportMemberName; role: 'member' }

/** Exactly four synthetic members, only in this test's freshly authenticated real owner's untouched workspace. */
export async function addReportSyntheticMembers(workspaceId: string, realOwnerId: string): Promise<ReportSyntheticMember[]> {
  const ws = idSchema.parse(workspaceId), owner = idSchema.parse(realOwnerId);
  const url = requirePrivateMembershipDatabase();
  const database = decodeURIComponent(url.pathname.slice(1));
  // Re-assert the same guard locally so a future change to the shared helper cannot widen this fixture.
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '60651'
    || decodeURIComponent(url.username) !== 'workloom_qa' || !/^workloom_test_[a-z0-9_]+_test$/.test(database)
    || url.search !== '' || url.hash !== '') {
    throw new Error('Report fixtures require the explicitly owned loopback60651 throwaway child; no fallback.');
  }
  const sql = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 3, onnotice: () => undefined });
  try {
    return await sql.begin(async tx => {
      const [connection] = await tx<{ database: string; username: string; host: string; port: number }[]>`
        select current_database() as database, current_user as username,
          host(inet_server_addr()) as host, inet_server_port()::int as port`;
      if (!connection || connection.database !== database || connection.username !== 'workloom_qa'
        || connection.host !== '127.0.0.1' || connection.port !== 60651) throw new Error('Private fixture connection identity mismatch.');
      const [workspace] = await tx<{ id: string; age: string }[]>`
        select w.id, extract(epoch from (now() - w.created_at))::text as age
        from workspaces w join memberships m on m.workspace_id = w.id join users u on u.id = m.user_id
        where w.id = ${ws} and m.user_id = ${owner} and m.role = 'owner' and m.state = 'active'
          and u.kind = 'real' for update of w`;
      const age = Number(workspace?.age);
      if (!workspace || !Number.isFinite(age) || age < 0 || age > 300) throw new Error('Expected this test freshly authenticated real owner workspace.');
      const [scope] = await tx<{ memberships: number; projects: number }[]>`
        select (select count(*)::int from memberships where workspace_id = ${ws}) as memberships,
          (select count(*)::int from projects where workspace_id = ${ws}) as projects`;
      if (!scope || scope.memberships !== 1 || scope.projects !== 0) throw new Error('Report fixture requires an untouched owned workspace.');
      const members: ReportSyntheticMember[] = REPORT_MEMBER_NAMES.map(displayName => ({
        id: randomUUID(), userId: randomUUID(), displayName, role: 'member',
      }));
      for (const member of members) {
        await tx`insert into users (id, display_name, kind) values (${member.userId}, ${member.displayName}, 'fixture')`;
        await tx`insert into memberships (id, workspace_id, user_id, role, state) values (${member.id}, ${ws}, ${member.userId}, 'member', 'active')`;
      }
      await tx`update workspaces set permission_epoch = permission_epoch + 1, updated_at = now() where id = ${ws}`;
      return members;
    });
  } finally { await sql.end({ timeout: 5 }); }
}

/** API failures report only method/path/status; response bodies are never logged. */
export async function reportRead<T>(page: Page, path: string, parser: Parser<T>): Promise<T> {
  const response = await page.request.get(`${REPORT_APP}${path}`);
  expect(response.status(), `GET ${path}`).toBe(200);
  return parser.parse(await response.json());
}
export async function reportWrite<T>(page: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data: object, status: number, parser: Parser<T>): Promise<T> {
  const response = await page.request.fetch(`${REPORT_APP}${path}`, { method, data, headers: { Origin: REPORT_APP, 'Idempotency-Key': randomUUID() } });
  expect(response.status(), `${method} ${path}`).toBe(status);
  return parser.parse(await response.json());
}

export interface ReportWorkspace {
  page: Page; actorId: string; workspaceId: string; prefix: string;
  owner: MembershipDto; blair: MembershipDto; casey: MembershipDto; devon: MembershipDto; ellis: MembershipDto;
}

/** Actual shared sign-in of a brand-new provider identity; fixture writes happen only after it is proven real/shared. */
export async function signInReportOwner(page: Page, provider: FakeSharedAuth): Promise<ReportWorkspace> {
  const identity = provider.registerIdentity(`Avery report owner ${randomUUID()}`);
  await page.goto(`${REPORT_APP}/app`);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private test identity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: identity.buttonName, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeAttached();
  const meResponse = await page.request.get(`${REPORT_APP}/api/v1/me`);
  expect(meResponse.status(), 'GET /api/v1/me').toBe(200);
  const me = await meResponse.json() as { data: { actor: { id: string; kind: string }; authMode: string } };
  expect(me.data.authMode).toBe('shared'); expect(me.data.actor.kind).toBe('real');
  const workspaces = (await reportRead(page, '/api/v1/workspaces', workspaceListResponseSchema)).data;
  expect(workspaces).toHaveLength(1);
  const workspace = workspaces[0]; if (!workspace) throw new Error('Fresh owner workspace is missing.');
  expect(workspace.role).toBe('owner');
  const inserted = await addReportSyntheticMembers(workspace.id, me.data.actor.id);
  const prefix = `/api/v1/workspaces/${workspace.id}`;
  const members = (await reportRead(page, `${prefix}/memberships`, membershipListResponseSchema)).data;
  expect(members).toHaveLength(5);
  const owner = members.find(member => member.userId === me.data.actor.id);
  if (!owner) throw new Error('Owner membership is missing.');
  expect(owner.role).toBe('owner');
  const byName = (name: ReportMemberName): MembershipDto => {
    const expected = inserted.find(member => member.displayName === name);
    const dto = members.find(member => member.id === expected?.id);
    if (!expected || !dto) throw new Error(`Synthetic member ${name} is missing.`);
    expect(dto).toMatchObject({ userId: expected.userId, displayName: name, role: 'member' });
    return dto;
  };
  return {
    page, actorId: me.data.actor.id, workspaceId: workspace.id, prefix, owner,
    blair: byName('Blair report member'), casey: byName('Casey report member'),
    devon: byName('Devon report member'), ellis: byName('Ellis report member'),
  };
}

export interface ReportDataset {
  projectId: string; projectName: string; periodId: string; periodName: string; baselineId: string; baselineFrozenAt: string;
  fieldId: string; designId: string; maintenanceId: string;
  tasks: { a: TaskDto; b: TaskDto; c: TaskDto; d: TaskDto; e: TaskDto; u: TaskDto };
  logs: { a: ManualPeriodWorkLogDto; b: ManualPeriodWorkLogDto; d: ManualPeriodWorkLogDto; e: ManualPeriodWorkLogDto; u: ManualPeriodWorkLogDto };
}

/**
 * Fixed synthetic dataset, written through the actual API in the documented order:
 * four baseline tasks/commitments, category field values and binding, a separate unplanned task (Ellis)
 * that exists in the project before freeze but never gets a commitment, project freeze,
 * then an added task/commitment (Ellis) and all first facts.
 */
export async function createReportDataset(f: ReportWorkspace): Promise<ReportDataset> {
  const { page, prefix } = f;
  const projectName = `Synthetic report project ${randomUUID().slice(0, 8)}`;
  const project = (await reportWrite(page, 'POST', `${prefix}/projects`, { name: projectName }, 201, projectResponseSchema)).data;
  const statuses = (await reportRead(page, `${prefix}/projects/${project.id}/statuses`, taskStatusListResponseSchema)).data;
  const todo = statuses.find(status => status.group === 'todo'); if (!todo) throw new Error('Todo status is missing.');
  const task = async (title: string, member: MembershipDto) => (await reportWrite(page, 'POST', `${prefix}/tasks`, {
    projectId: project.id, statusId: todo.id, title, responsibleMembershipId: member.id, participantMembershipIds: [member.id],
  }, 201, taskResponseSchema)).data;
  const periodName = 'Synthetic report week';
  const period = (await reportWrite(page, 'POST', `${prefix}/periods`, {
    projectId: project.id, name: periodName, localStart: '2027-05-03', timezone: 'Asia/Nicosia',
    cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false,
  }, 201, planningPeriodResponseSchema)).data;
  expect(period).toMatchObject({ localStart: '2027-05-03', localEndExclusive: '2027-05-10', timezone: 'Asia/Nicosia', state: 'planning' });
  const commit = async (t: TaskDto, member: MembershipDto, minutes: number | null) => (await reportWrite(page, 'POST', `${prefix}/periods/${period.id}/commitments`, {
    workPackageId: t.workPackageId, membershipId: member.id, expectedAbsent: true, plannedMinutes: minutes,
    allocations: minutes === null ? [] : [{ taskId: t.id, minutes }],
  }, 201, periodCommitmentResponseSchema)).data;

  const a = await task('Synthetic report task A', f.owner);
  const b = await task('Synthetic report task B', f.blair);
  const c = await task('Synthetic report task C', f.casey);
  const d = await task('Synthetic report task D', f.devon);
  for (const [t, member, minutes] of [[a, f.owner, 120], [b, f.blair, 60], [c, f.casey, 90], [d, f.devon, null]] as const) {
    expect(await commit(t, member, minutes)).toMatchObject({ plannedMinutes: minutes, classification: 'planned', state: 'active' });
  }

  const field = (await reportWrite(page, 'POST', `${prefix}/fields`, {
    projectId: project.id, name: 'Synthetic work type', type: 'single_select',
    options: [{ name: 'Design', color: '#6366f1' }, { name: 'Maintenance', color: '#0d9488' }],
  }, 201, taskFieldDefinitionResponseSchema)).data;
  const design = field.options.find(option => option.name === 'Design');
  const maintenance = field.options.find(option => option.name === 'Maintenance');
  if (!design || !maintenance) throw new Error('Category options are missing.');
  for (const [t, option] of [[a, design], [d, maintenance]] as const) {
    await reportWrite(page, 'PUT', `${prefix}/tasks/${t.id}/field-values/${field.id}`, {
      expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: option.id },
    }, 200, taskFieldValueResponseSchema);
  }
  const currentBinding = (await reportRead(page, `${prefix}/projects/${project.id}/work-category-binding`, projectWorkCategoryBindingResponseSchema)).data;
  const binding = (await reportWrite(page, 'PATCH', `${prefix}/projects/${project.id}/work-category-binding`, {
    expectedRevision: currentBinding.revision, fieldId: field.id,
  }, 200, projectWorkCategoryBindingResponseSchema)).data;
  expect(binding).toMatchObject({ fieldId: field.id, availability: 'active' });
  // Unplanned only because its package is in the frozen project census without a baseline commitment.
  const u = await task('Synthetic report task unplanned', f.ellis);

  const preview = (await reportWrite(page, 'POST', `${prefix}/periods/${period.id}/freeze-preview`, { scope: 'project' }, 200, freezePreviewResponseSchema)).data;
  const baseline = (await reportWrite(page, 'POST', `${prefix}/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, 200, planBaselineResponseSchema)).data;
  expect(baseline).toMatchObject({ scope: 'project', periodId: period.id });
  const snapshot = baseline.snapshot;
  expect(snapshot.projectPackageIds).toEqual(expect.arrayContaining([a, b, c, d, u].map(t => t.workPackageId)));
  expect(snapshot.commitments.some(commitment => commitment.workPackageId === u.workPackageId)).toBe(false);
  expect(snapshot.commitments).toHaveLength(4);
  expect(snapshot.commitments).toEqual(expect.arrayContaining([
    expect.objectContaining({ workPackageId: a.workPackageId, membershipId: f.owner.id, plannedMinutes: 120, state: 'active' }),
    expect.objectContaining({ workPackageId: b.workPackageId, membershipId: f.blair.id, plannedMinutes: 60, state: 'active' }),
    expect.objectContaining({ workPackageId: c.workPackageId, membershipId: f.casey.id, plannedMinutes: 90, state: 'active' }),
    expect.objectContaining({ workPackageId: d.workPackageId, membershipId: f.devon.id, plannedMinutes: null, state: 'active' }),
  ]));

  const e = await task('Synthetic report task E added', f.ellis);
  // E did not exist at freeze, so its package is outside the baseline census and reports as added scope.
  expect(snapshot.projectPackageIds).not.toContain(e.workPackageId);
  expect(await commit(e, f.ellis, 30)).toMatchObject({ plannedMinutes: 30, classification: 'added' });

  const fact = async (t: TaskDto, member: MembershipDto, minutes: number) => {
    const log = (await reportWrite(page, 'PUT', `${prefix}/tasks/${t.id}/manual-period-work/${period.id}/${member.id}`, {
      expectedRevision: null, minutes, state: 'active',
    }, 200, manualPeriodWorkLogResponseSchema)).data;
    expect(log).toMatchObject({ minutes, state: 'active', revision: 1, periodId: period.id, membershipId: member.id });
    return log;
  };
  const logs = {
    a: await fact(a, f.owner, 150), b: await fact(b, f.blair, 0), d: await fact(d, f.devon, 45),
    e: await fact(e, f.ellis, 20), u: await fact(u, f.ellis, 10),
  };
  return {
    projectId: project.id, projectName, periodId: period.id, periodName, baselineId: baseline.id, baselineFrozenAt: baseline.frozenAt,
    fieldId: field.id, designId: design.id, maintenanceId: maintenance.id, tasks: { a, b, c, d, e, u }, logs,
  };
}

/** Explicit server correction of A from 150 to 180, after both original reports are saved. */
export async function correctTaskA(f: ReportWorkspace, data: ReportDataset): Promise<ManualPeriodWorkLogDto> {
  const corrected = (await reportWrite(f.page, 'PUT', `${f.prefix}/tasks/${data.tasks.a.id}/manual-period-work/${data.periodId}/${f.owner.id}`, {
    expectedRevision: 1, minutes: 180, state: 'active', reason: 'Synthetic report correction',
  }, 200, manualPeriodWorkLogResponseSchema)).data;
  expect(corrected).toMatchObject({ id: data.logs.a.id, revision: 2, minutes: 180, state: 'active' });
  expect(corrected.revisionId).not.toBe(data.logs.a.revisionId);
  return corrected;
}
