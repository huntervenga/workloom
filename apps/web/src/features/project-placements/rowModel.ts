import type { ProjectRowDto, TaskStatusDto } from '@workloom/contracts';
import type { TaskFilterValue } from '../tasks/TaskFilters';

/** A placement never changes TaskDto.projectId, parentTaskId, sectionId or workPackageId. */
export function linkedRows(rows: readonly ProjectRowDto[], viewedProjectId: string, filters: TaskFilterValue) {
  const search = filters.search.trim().toLocaleLowerCase();
  return rows.filter(row => {
    const { canonicalTask: task, placement, canonicalStatus } = row;
    return placement.projectId === viewedProjectId && task.projectId !== viewedProjectId && task.meetingId === null && task.visibility === 'workspace'
      && (filters.includeArchived || placement.archivedAt === null && task.archivedAt === null)
      && (!search || `${task.title} ${task.description}`.toLocaleLowerCase().includes(search))
      && (filters.completion !== 'open' || canonicalStatus.group === 'todo' || canonicalStatus.group === 'in_progress')
      && (!filters.statusId || canonicalStatus.id === filters.statusId)
      && (!filters.tagId || task.tags.some(tag => tag.id === filters.tagId))
      && (!filters.participantMembershipId || task.participants.some(person => person.membershipId === filters.participantMembershipId && person.active));
  });
}
export function canonicalStatusTarget(row: ProjectRowDto, statuses: readonly TaskStatusDto[], statusId: string) {
  return statuses.find(status => status.id === statusId && status.projectId === row.canonicalTask.projectId && status.workspaceId === row.canonicalTask.workspaceId);
}
/** No loaded-row estimate/hour total: one canonical source may be visible in several projects. */
export function byHomeProject(rows: readonly ProjectRowDto[]) {
  const groups = new Map<string, ProjectRowDto[]>();
  for (const row of rows) groups.set(row.homeProject.id, [...(groups.get(row.homeProject.id) ?? []), row]);
  return [...groups.values()];
}
