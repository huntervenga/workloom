import type { CategorizedWorkLogDto, ProjectWorkCategoryBindingDto, TaskFieldDefinitionDto, TaskTimeSummaryDto, WorkCategorySnapshot, WorkTypeReportRunDto } from '@workloom/contracts';
import { alpha, alphaMembers, anna, ok, type RouteTable } from '../../../test/fakeApi';
import { field, FIELD_ID, OPTION_ID, STAMP as FIELD_STAMP } from '../../fields/test/fixtures';
import { MEMBER_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, TASK_ID, commitment, log, routes, rootPath, task } from '../../planning/test/fixtures';
export { MEMBER_ID, PACKAGE_ID, PERIOD_A, PROJECT_ID, TASK_ID, rootPath, task };
export const FIELD = FIELD_ID;
export const OPTION_A = OPTION_ID;
export const OPTION_B = '91000000-0000-4000-8000-000000000002';
export const BINDING_VERSION = 'fa000000-0000-4000-8000-000000000001';
export const TYPE_RUN = 'fb000000-0000-4000-8000-000000000001';
export const tablePath = `/w/${alpha.id}/projects/${PROJECT_ID}`;
export function definition(): TaskFieldDefinitionDto { return { ...field('Направление работы', 'single_select'), options: [{ id: OPTION_A, name: 'Исследование', color: '#6366f1', position: 0, revision: 1, archivedAt: null }, { id: OPTION_B, name: 'Поддержка команды', color: '#0d9488', position: 1, revision: 1, archivedAt: null }] }; }
export function binding(active = true): ProjectWorkCategoryBindingDto { return { workspaceId: alpha.id, projectId: PROJECT_ID, revision: active ? 2 : 1, versionId: active ? BINDING_VERSION : null, fieldId: active ? FIELD_ID : null, availability: active ? 'active' : 'unbound' }; }
export function category(option = OPTION_A, label = 'Исследование'): WorkCategorySnapshot { return { kind: 'categorized', bindingVersionId: BINDING_VERSION, bindingRevision: 2, fieldId: FIELD_ID, fieldDefinitionVersionId: definition().definitionVersionId, fieldLabel: 'Направление работы', optionId: option, optionRevision: 1, optionLabel: label, color: '#6366f1', optionArchivedAt: null }; }
export function categorized(minutes = 60, revision = 1): CategorizedWorkLogDto { return { ...log(minutes, revision), category: category() }; }
export function projection(workerId = MEMBER_ID, source: CategorizedWorkLogDto | null = null): TaskTimeSummaryDto {
  return { workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, subjectMembershipId: workerId, asOfChangeSeq: '1', tasks: [{ taskId: TASK_ID, workPackageId: PACKAGE_ID, currentAllocationMinutes: null, ownManualWork: source, subjectActualMinutes: source?.state === 'active' ? source.minutes : 0, taskActualMinutes: source?.state === 'active' ? source.minutes : 0, subjectActiveSourceCount: source?.state === 'active' ? 1 : 0, taskActiveSourceCount: source?.state === 'active' ? 1 : 0, hasOtherSources: false }], packages: [{ workPackageId: PACKAGE_ID, commitment: null, subjectActualMinutes: source?.state === 'active' ? source.minutes : 0, totalActualMinutes: source?.state === 'active' ? source.minutes : 0, subjectActiveSourceCount: source?.state === 'active' ? 1 : 0, totalActiveSourceCount: source?.state === 'active' ? 1 : 0 }] };
}
export function categoryReport(): WorkTypeReportRunDto {
  const byCategory = [
    { key: `${FIELD_ID}:${OPTION_A}`, fieldId: FIELD_ID, optionId: OPTION_A, label: 'Исследование', color: '#6366f1', minutes: 60, sharePercent: 50 },
    { key: `${FIELD_ID}:${OPTION_B}`, fieldId: FIELD_ID, optionId: OPTION_B, label: 'Поддержка команды', color: '#0d9488', minutes: 30, sharePercent: 25 },
    { key: 'uncategorized', fieldId: null, optionId: null, label: 'Uncategorized', color: null, minutes: 30, sharePercent: 25 },
  ];
  return { id: TYPE_RUN, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, metricVersion: 'weekly_work_type_v1', createdAt: FIELD_STAMP, actorUserId: anna.id, factCutoffAt: FIELD_STAMP, factChangeSeq: '3', membershipIds: [MEMBER_ID], totalActualMinutes: 120, activeSourceCount: 3, categorizedMinutes: 90, uncategorizedMinutes: 30, byCategory, byPerson: [{ membershipId: MEMBER_ID, memberName: alphaMembers[0]?.displayName ?? 'Анна', totalActualMinutes: 120, activeSourceCount: 3, byCategory }], rowCount: 0, workLogRevisionIds: [], labelPolicy: 'highest_option_revision_then_change_seq_then_id' };
}
export function tableRoutes(): RouteTable {
  return { ...routes(), [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok([]), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([{ id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Запланировано', group: 'todo', position: 0, revision: 1 }]), [`GET ${rootPath}/tags`]: () => ok([]), [`GET ${rootPath}/fields`]: () => ok([definition()]), [`GET ${rootPath}/projects/${PROJECT_ID}/work-category-binding`]: () => ok(binding()), [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_A}/task-time-summary`]: (request) => ok(projection(request.searchParams.get('membershipId') ?? MEMBER_ID)) };
}
export function plannedProjection(): TaskTimeSummaryDto {
  const result = projection();
  const work = result.packages[0];
  if (!work) throw new Error('Missing package fixture');
  work.commitment = { ...commitment(), allocations: [{ taskId: TASK_ID, minutes: 360 }], unallocatedMinutes: 0 };
  const row = result.tasks[0];
  if (row) row.currentAllocationMinutes = 360;
  return result;
}
