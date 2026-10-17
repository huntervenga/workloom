import type { TaskDto, TaskScheduleContextRowDto } from '@workloom/contracts';
import { dayIndex, MAX_DAY, shiftDay } from './dates';

/** A gesture keeps the authorized original source even if another read later arrives. */
export interface DateMoveSource {
  readonly taskId: string;
  readonly title: string;
  readonly expectedRevision: number;
  readonly startDate: string | null;
  readonly dueDate: string | null;
}
export interface DateMoveProposal {
  readonly source: DateMoveSource;
  readonly startDate: string | null;
  readonly dueDate: string | null;
  readonly dayDelta: number;
  readonly limited: boolean;
}
export const DATE_MOVE_THRESHOLD = 4;

export function dateMoveSource(task: TaskDto | undefined, row: TaskScheduleContextRowDto | undefined, options: {
  projectId: string; writable: boolean; ready: boolean; baseline?: boolean; blocked?: boolean;
}): DateMoveSource | null {
  if (!task || !row || !options.writable || !options.ready || options.baseline || options.blocked ||
    task.id !== row.taskId || task.projectId !== options.projectId || task.archivedAt || task.meetingId || row.meetingId || !row.editableDates) return null;
  const { startDate, dueDate } = row.current;
  const start = startDate === null ? null : dayIndex(startDate), due = dueDate === null ? null : dayIndex(dueDate);
  if (startDate !== null && start === null || dueDate !== null && due === null || start === null && due === null ||
    start !== null && due !== null && start > due || !Number.isInteger(row.taskRevision) || row.taskRevision < 1) return null;
  return Object.freeze({ taskId: task.id, title: task.title, expectedRevision: row.taskRevision, startDate, dueDate });
}

/** Half-day ties go away from zero in both directions; JavaScript Math.round is asymmetric. */
export function snappedDayDelta(pixels: number, pixelsPerDay: number): number | null {
  if (!Number.isFinite(pixels) || !Number.isFinite(pixelsPerDay) || pixelsPerDay <= 0) return null;
  const value = pixels / pixelsPerDay;
  if (!Number.isFinite(value)) return null;
  const days = Math.floor(Math.abs(value) + 0.5);
  return days === 0 ? 0 : Math.sign(value) * days;
}

/** Clamp the shared delta, never individual endpoints: the inclusive range length stays fixed. */
export function moveDateRange(source: DateMoveSource, requestedDelta: number): DateMoveProposal | null {
  if (!Number.isSafeInteger(requestedDelta)) return null;
  const known = [source.startDate, source.dueDate].filter((value): value is string => value !== null);
  const indexes = known.map(dayIndex);
  if (!indexes.length || indexes.some(index => index === null) || source.startDate !== null && source.dueDate !== null && source.startDate > source.dueDate) return null;
  const first = Math.min(...indexes as number[]), last = Math.max(...indexes as number[]), max = dayIndex(MAX_DAY);
  if (max === null) return null;
  const dayDelta = Math.max(-first, Math.min(max - last, requestedDelta));
  const startDate = source.startDate === null ? null : shiftDay(source.startDate, dayDelta);
  const dueDate = source.dueDate === null ? null : shiftDay(source.dueDate, dayDelta);
  if (source.startDate !== null && startDate === null || source.dueDate !== null && dueDate === null) return null;
  return Object.freeze({ source, startDate, dueDate, dayDelta, limited: dayDelta !== requestedDelta });
}

export function dateMoveAtPixels(source: DateMoveSource, pixels: number, pixelsPerDay: number): DateMoveProposal | null {
  const days = snappedDayDelta(pixels, pixelsPerDay);
  return days === null ? null : moveDateRange(source, days);
}
