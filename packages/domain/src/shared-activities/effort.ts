import type { PersonalEffortContributionDto, PersonalEffortResultDto, SharedActivityRecordDto, TaskFieldValueDto } from '@workloom/contracts';
import { DomainError } from '../errors.js';

export interface PersonalEffortSource {
  tasks: readonly { id: string; projectId: string; responsibleMembershipId: string | null }[];
  values: readonly TaskFieldValueDto[];
  sharedActivities?: readonly Pick<SharedActivityRecordDto, 'activity' | 'contributions'>[];
}
export interface PersonalEffortSelection { fieldId: string; membershipId?: string; taskIds?: readonly string[]; categoryFieldId?: string | null }
const id = (value: string) => value.toLowerCase();
/** Sole attribution calculator. Callers provide the complete authorized canonical task scope;
 * member filtering happens AFTER shared attendance expansion. No loaded-page totals or event-duration addition. */
export function calculatePersonalEffort(source: PersonalEffortSource, selection: PersonalEffortSelection): PersonalEffortResultDto {
  const fieldId = id(selection.fieldId), selectedTasks = selection.taskIds ? new Set(selection.taskIds.map(id)) : null;
  const selectedMember = selection.membershipId ? id(selection.membershipId) : null;
  const activities = new Map<string,Pick<SharedActivityRecordDto,'activity'|'contributions'>>();
  for(const record of source.sharedActivities??[]){const key=id(record.activity.taskId);if(activities.has(key))throw new DomainError('DOMAIN_VALIDATION_FAILED','A canonical task has duplicate shared activity sources.');activities.set(key,record);}
  const values = new Map(source.values.map(value => [`${id(value.taskId)}:${id(value.fieldId)}`, value]));
  const seen = new Set<string>(), contributions: PersonalEffortContributionDto[] = [];
  for (const task of source.tasks) {
    const taskId = id(task.id); if (seen.has(taskId) || (selectedTasks && !selectedTasks.has(taskId))) continue; seen.add(taskId);
    const record = activities.get(taskId), activity = record?.activity;
    if(activity&&id(activity.projectId)!==id(task.projectId))throw new DomainError('DOMAIN_VALIDATION_FAILED','A shared activity does not belong to its canonical task home project.');
    if (record && activity && id(activity.projectId) === id(task.projectId) && (id(activity.planFieldId) === fieldId || id(activity.factFieldId) === fieldId)) {
      const planned = id(activity.planFieldId) === fieldId;
      const members=new Set<string>();
      for (const row of record.contributions) {
        if(members.has(id(row.membershipId)))throw new DomainError('DOMAIN_VALIDATION_FAILED','A shared activity has duplicate participant sources.');members.add(id(row.membershipId));
        if (selectedMember && id(row.membershipId) !== selectedMember) continue;
        if (planned ? !row.rosterActive : !row.rosterActive && row.confirmedActivityRevision === null) continue;
        const known = planned || row.postingState === 'active';
        const planValue = planned && !row.plannedOverride ? values.get(`${taskId}:${fieldId}`) : undefined;
        const minutes = planned ? row.plannedOverride ? row.currentPlannedMinutes : planValue?.value.type === 'duration' ? planValue.value.value : null : known ? row.minutes : null;
        if(minutes!==null&&(!Number.isSafeInteger(minutes)||minutes<0))throw new DomainError('DOMAIN_VALIDATION_FAILED','Shared effort requires nonnegative whole minutes.');
        contributions.push({ sourceKey: `${id(row.id)}:${planned ? 'plan' : 'actual'}`, sourceKind: planned ? 'shared_plan' : 'shared_attendance',
          taskId: task.id, membershipId: row.membershipId, fieldId: selection.fieldId, minutes,
          state: row.postingState === 'void' && !planned ? 'void' : minutes === null ? 'unknown' : 'value',
          sourceRevision: row.revision, activityRevision: planned ? row.plannedActivityRevision : row.confirmedActivityRevision,
          occurrenceDate: planned ? activity.occurrenceDate : row.confirmedOccurrenceDate ?? activity.occurrenceDate,
          category: planned ? null : row.category,
        });
      }
      continue;
    }
    if (selectedMember && (task.responsibleMembershipId === null || id(task.responsibleMembershipId) !== selectedMember)) continue;
    const value = values.get(`${taskId}:${fieldId}`), usable = value && id(value.projectId) === id(task.projectId) ? value : null;
    if (usable && usable.value.type !== 'duration') throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Personal effort requires a duration field.');
    const raw = usable?.value.value;
    if (raw !== undefined && raw !== null && (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Personal effort requires nonnegative whole minutes.');
    contributions.push({ sourceKey: `task:${taskId}:${fieldId}`, sourceKind: 'ordinary_task', taskId: task.id, membershipId: task.responsibleMembershipId,
      fieldId: selection.fieldId, minutes: typeof raw === 'number' ? raw : null, state: !usable ? 'missing' : raw === null ? 'null' : 'value',
      sourceRevision: usable?.revision ?? null, activityRevision: null, occurrenceDate: null, category: null });
  }
  if (contributions.length > 50000) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The complete personal effort scope exceeds 50000 contributions; no partial total was calculated.');
  return summarizePersonalEffort(contributions);
}
/** Aggregate only a subset of already-authorized contribution identities, preserving unknown coverage. */
export function summarizePersonalEffort(contributions: PersonalEffortContributionDto[]): PersonalEffortResultDto {
  contributions=[...new Map(contributions.map(row=>[row.sourceKey,row])).values()];
  contributions.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  const known = contributions.filter(row => row.state === 'value' && row.minutes !== null), total = known.reduce((sum, row) => sum + (row.minutes ?? 0), 0);
  if (!Number.isSafeInteger(total)) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Personal effort exceeds the safe whole-minute total.');
  // With unknown sources, minutes is a known subtotal; callers must display coverage.
  return { minutes: known.length ? total : null, canonicalTaskCount: new Set(contributions.map(row => id(row.taskId))).size,
    participationCount: contributions.filter(row => row.sourceKind !== 'ordinary_task').length,
    coverage: { sources: contributions.length, known: known.length, unknown: contributions.filter(row => row.state !== 'value' && row.state !== 'void').length,
      zero: known.filter(row => row.minutes === 0).length, void: contributions.filter(row => row.state === 'void').length }, contributions };
}
