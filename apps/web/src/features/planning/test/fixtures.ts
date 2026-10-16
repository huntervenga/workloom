import type { CutoffReadinessDto, ManualPeriodWorkLogDto, PeriodCommitmentDto, PlanBaselineDto, PlanningPackageDto, PlanningPeriodDto, PlanningSnapshotDto, TaskDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactSummaryDto } from '@workloom/contracts';
import { alpha, alphaMembers, anna, ok, project, singleActorRoutes, type RouteTable } from '../../../test/fakeApi';

export const PROJECT_ID = 'e0000000-0000-4000-8000-000000000001';
export const PERIOD_A = 'f0000000-0000-4000-8000-000000000001';
export const PERIOD_B = 'f0000000-0000-4000-8000-000000000002';
export const PACKAGE_ID = 'f1000000-0000-4000-8000-000000000001';
export const TASK_ID = 'f2000000-0000-4000-8000-000000000001';
export const COMMITMENT_ID = 'f3000000-0000-4000-8000-000000000001';
export const BASELINE_ID = 'f4000000-0000-4000-8000-000000000001';
export const PERSONAL_BASELINE_ID = 'f4000000-0000-4000-8000-000000000002';
export const RUN_ID = 'f5000000-0000-4000-8000-000000000001';
export const MEMBER_ID = 'c0000000-0000-4000-8000-000000000001';
export const STAMP = '2026-10-19T09:00:00.000Z';
export const rootPath = `/api/v1/workspaces/${alpha.id}`;
export const weekPath = `/w/${alpha.id}/projects/${PROJECT_ID}/week`;
export const task: TaskDto = { meetingId:null, id: TASK_ID, workspaceId: alpha.id, projectId: PROJECT_ID, sectionId: null, parentTaskId: null, workPackageId: PACKAGE_ID, workPackageRevision: 1, title: 'Исследовать недельный сценарий', description: '', statusId: 'f6000000-0000-4000-8000-000000000001', responsibleMembershipId: MEMBER_ID, participants: [], participantsRevision: 1, dueDate: null, priority: 'none', tags: [], estimateMinutes: 1200, revision: 1, position: 0, visibility: 'workspace', archivedAt: null, createdAt: STAMP, updatedAt: STAMP };
export const work: PlanningPackageDto = { id: PACKAGE_ID, projectId: PROJECT_ID, revision: 1, estimateMinutes: 1200, createdAt: STAMP, packageBaselineId: null, title: task.title };
export function period(id = PERIOD_A): PlanningPeriodDto { return { id, workspaceId: alpha.id, projectId: PROJECT_ID, name: id === PERIOD_A ? 'Неделя А' : 'Неделя Б', localStart: id === PERIOD_A ? '2026-10-19' : '2026-10-26', localEndExclusive: id === PERIOD_A ? '2026-10-26' : '2026-11-02', timezone: alpha.timezone, cutoffAt: '2026-10-19T12:00:00.000Z', state: 'planning', revision: 1, protectedFieldIds: [], protectEstimate: true, projectBaselineId: null, createdAt: STAMP, updatedAt: STAMP }; }
export function commitment(plannedMinutes = 360): PeriodCommitmentDto { return { id: COMMITMENT_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, workPackageId: PACKAGE_ID, membershipId: MEMBER_ID, plannedMinutes, allocations: [], unallocatedMinutes: plannedMinutes, state: 'active', revision: 1, classification: 'planned', baselineIds: [], createdAt: STAMP, updatedAt: STAMP }; }
export function snapshot(): PlanningSnapshotDto { return { schemaVersion: 1, period: period(), commitments: [commitment()], packages: [work], projectPackageIds: [PACKAGE_ID], tasks: [task], memberships: alphaMembers, fieldDefinitions: [], fieldValues: [], sourcePersonalBaselineIds: [] }; }
export function baseline(personal = false): PlanBaselineDto { return { id: personal ? PERSONAL_BASELINE_ID : BASELINE_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, scope: personal ? 'self' : 'project', membershipId: personal ? MEMBER_ID : null, mode: 'manual', requestedCutoffAt: STAMP, frozenAt: STAMP, actorUserId: anna.id, source: 'web', changeSeq: '1', snapshot: snapshot() }; }
export function log(minutes = 0, revision = 1): ManualPeriodWorkLogDto { return { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, projectId: PROJECT_ID, taskId: TASK_ID, workPackageId: PACKAGE_ID, membershipId: MEMBER_ID, periodId: PERIOD_A, sourceKind: 'manual_period', sourceKey: 'manual-fixture', precision: 'period', revision, revisionId: `f8000000-0000-4000-8000-${String(revision).padStart(12, '0')}`, minutes, state: 'active', reason: revision === 1 ? null : 'Уточнил часы', actorUserId: anna.id, recordedAt: STAMP, changeSeq: String(revision) }; }
export function summary(): WeeklyPlanFactSummaryDto { return { knownPlannedMinutes: 360, actualMinutes: 300, missingEstimateCount: 0, baselineCompleteness: { knownItemCount: 1, totalItemCount: 1, ratio: 1, complete: true }, factCoverage: { recordedItemCount: 1, totalItemCount: 1, ratio: 1, complete: true }, totalVarianceMinutes: -60, totalVariancePercent: -100 / 6, addedActualMinutes: 0, unplannedActualMinutes: 0, totalActualMinutes: 300 }; }
export function report(): WeeklyPlanFactReportRunDto { return { id: RUN_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, baselineId: BASELINE_ID, metricVersion: 'weekly_plan_fact_v1', createdAt: STAMP, actorUserId: anna.id, factCutoffAt: STAMP, factChangeSeq: '1', membershipIds: [MEMBER_ID], knownEstimatesOnly: false, cohort: { selectedItemCount: 1, originalItemCount: 1 }, summary: summary(), byPerson: [{ membershipId: MEMBER_ID, memberName: anna.displayName, summary: summary() }], rowCount: 1, workLogRevisionIds: [] }; }
export function routes(): RouteTable {
  const result: RouteTable = {
    ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
    [`GET ${rootPath}/projects/${PROJECT_ID}`]: () => ok(project(alpha.id, PROJECT_ID, 'Недельный пилот')),
    [`GET ${rootPath}/periods`]: () => ok([period(), period(PERIOD_B)]),
    [`GET ${rootPath}/planning-packages`]: () => ok([work]),
    [`GET ${rootPath}/tasks`]: () => ok([task]),
  };
  for (const id of [PERIOD_A, PERIOD_B]) {
    result[`GET ${rootPath}/periods/${id}`] = () => ok(period(id));
    result[`GET ${rootPath}/periods/${id}/cutoff-readiness`] = () => ok(cutoffReadiness(period(id)));
    for (const suffix of ['commitments', 'baselines']) result[`GET ${rootPath}/periods/${id}/${suffix}`] = () => ok([]);
  }
  result[`GET ${rootPath}/worklogs`] = () => ok([]);
  result[`GET ${rootPath}/recorded-work`] = () => ok([]);
  result[`GET ${rootPath}/projects/${PROJECT_ID}/meetings`] = () => ok([]);
  result[`GET ${rootPath}/report-runs`] = () => ok([]);
  return result;
}
/** Explicit unconfigured readiness fixture; frozen cases must provide their real test baseline. */
export function cutoffReadiness(target:PlanningPeriodDto=period(),saved:CutoffReadinessDto['baseline']=null):CutoffReadinessDto {
 if(target.state==='frozen'&&!saved)throw new Error('A frozen readiness fixture needs explicit baseline timestamps.');
 return {periodId:target.id,periodRevision:target.revision,persistedState:saved?'frozen':'planning',serverNow:STAMP,cutoffAt:target.cutoffAt,baseline:saved,automation:{state:'not_configured',grant:null},readiness:saved?'frozen':'planning',missingCount:0,blockedCount:0,blockers:[],truncated:false,latestRequest:null,latestOutcome:null,actions:{canConfigure:true,canRetry:false,canFreezeProject:!saved}};
}
export function lostResponse() {
  let lose: () => void = () => undefined;
  const promise = new Promise<Response>((_resolve, reject) => { lose = () => reject(new TypeError('Failed to fetch')); });
  return { promise, lose };
}
