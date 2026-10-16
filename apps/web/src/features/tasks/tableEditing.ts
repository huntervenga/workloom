import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { changedKeys, draftFromTask, emptyDraft, type TaskDraft } from './taskDraft';
import type { CreateSession, EditSession } from './useTaskCommands';

export type TaskInlineField = 'title' | 'statusId' | 'responsibleMembershipId' | 'dueDate';

/** View/recovery mapping must follow the edited field rather than assume a date fallback. */
export function taskInlineColumn(field: TaskInlineField) {
  switch (field) {
    case 'title': return field;
    case 'statusId': return 'status';
    case 'responsibleMembershipId': return 'responsible';
    case 'dueDate': return field;
  }
}

export function canEditTaskInline(task: TaskDto): boolean {
  // Missing task type belongs to a retained older response and must be refreshed first.
  return task.archivedAt === null && task.meetingId === null;
}

export function defaultTaskStatusId(statuses: readonly TaskStatusDto[]): string | null {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  return (ordered.find(status => status.group === 'todo') ?? ordered[0])?.id ?? null;
}

export function freshQuickSession(sectionId: string | null, statusId: string): CreateSession {
  return { request: { sectionId, parent: null }, draft: emptyDraft(statusId, sectionId), workScope: 'detail', origin: 'quick' };
}

export function canResumeQuickSession(session: CreateSession, sectionId: string | null): boolean {
  if (session.origin !== 'quick' || session.request.parent !== null || session.request.sectionId !== sectionId) return false;
  const basicFields = new Set<keyof TaskDraft>(['title', 'statusId', 'responsibleMembershipId', 'dueDate']);
  return changedKeys(emptyDraft(session.draft.statusId, sectionId), session.draft).every(key => basicFields.has(key));
}

export function canResumeInlineSession(session: EditSession, field: TaskInlineField): boolean {
  const changed = changedKeys(draftFromTask(session.base), session.draft);
  return changed.length === 0 || session.inlineField === field && changed.every(key => key === field);
}
