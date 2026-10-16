import { taskScheduleContextSchema, taskSchedulePreviewSchema, type TaskDto, type TaskScheduleBatchInput, type BaselineTaskDatesDto } from '@workloom/contracts';
import { taskAt, summary } from '../../dependencies/test/fixtures';
import { BASELINE_ID, PERIOD_A, PROJECT_ID, STAMP, rootPath } from '../../planning/test/fixtures';
export { BASELINE_ID, PERIOD_A, PROJECT_ID, STAMP, rootPath };
export const schedulePath = `${rootPath}/projects/${PROJECT_ID}`;
export function scheduledTask(index: number, startDate: string | null = null, dueDate: string | null = null): TaskDto {
  return { ...taskAt(index), startDate, dueDate };
}
export function scheduleContext(tasks: readonly TaskDto[], baseline = false, seq = '1', captured?: (task: TaskDto) => BaselineTaskDatesDto) {
  return taskScheduleContextSchema.parse({ projectId: PROJECT_ID, asOfChangeSeq: seq, baseline: baseline ? { baselineId: BASELINE_ID, periodId: PERIOD_A, scope: 'project', membershipId: null, frozenAt: STAMP, sourcePersonalBaselineIds: [] } : null,
    rows: tasks.map(task => ({ taskId: task.id, taskRevision: task.revision, current: { startDate: task.startDate ?? null, dueDate: task.dueDate }, meetingId: task.meetingId ?? null, editableDates: !task.meetingId && !task.archivedAt, blocking: summary(task.id), baselineDates: !baseline ? { state: 'not_selected' } : captured?.(task) ?? { state: 'captured', startDate: { state: 'not_captured' }, dueDate: task.dueDate === null ? { state: 'not_set' } : { state: 'set', value: task.dueDate } } })), comparisons: [] });
}
export function schedulePreview(input: TaskScheduleBatchInput, tasks: readonly TaskDto[], hash = 'a'.repeat(64)) {
  return taskSchedulePreviewSchema.parse({ projectId: PROJECT_ID, previewHash: hash, asOfChangeSeq: '1', rows: input.rows.map(row => { const task = tasks.find(task => task.id === row.taskId); return { taskId: row.taskId, expectedRevision: row.expectedRevision, before: { startDate: task?.startDate ?? null, dueDate: task?.dueDate ?? null }, after: { startDate: row.startDate, dueDate: row.dueDate }, changed: row.startDate !== (task?.startDate ?? null) || row.dueDate !== (task?.dueDate ?? null) }; }), comparisons: [], protectedTargets: [], recoveryPeriodIds: [] });
}
