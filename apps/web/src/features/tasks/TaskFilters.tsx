import { TagBadge } from './TagBadge';
import { tagColor } from './tagColors';
import { useTranslation } from '../../i18n';
import { taskListQuerySchema, type MembershipDto, type TagDto, type TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';

/**
 * All tasks, or only open ones. The server decides what is open (every todo and in-progress
 * status, custom ones included); loaded rows are never filtered on the client.
 */
export type TaskCompletionFilter = 'all' | 'open';

/**
 * What the user chose; applied on the server. Completion, status, participant, tag and archived
 * live in the page URL (see `readTaskFilterParams`); search text stays in memory, never in the URL.
 */
export interface TaskFilterValue {
  search: string;
  completion: TaskCompletionFilter;
  statusId: string;
  participantMembershipId: string;
  tagId: string;
  includeArchived: boolean;
}

export const emptyTaskFilters: TaskFilterValue = {
  search: '',
  completion: 'all',
  statusId: '',
  participantMembershipId: '',
  tagId: '',
  includeArchived: false,
};

export function hasActiveTaskFilters(value: TaskFilterValue): boolean {
  return value.search.trim() !== '' || value.completion === 'open' || value.statusId !== '' || value.participantMembershipId !== '' || value.tagId !== '' || value.includeArchived;
}

/** The URL-backed filters; search is never read from or written to the URL. */
export type TaskFilterParams = Omit<TaskFilterValue, 'search'>;

/** Each URL-backed filter owns exactly one page parameter. */
const filterParam = { completion: 'completion', statusId: 'status', participantMembershipId: 'participant', tagId: 'tag', includeArchived: 'includeArchived' } as const;

/** A repeated owned key is ambiguous; it receives the same safe default as invalid input. */
function single(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

function readId(params: URLSearchParams, key: string): string {
  const parsed = taskListQuerySchema.shape.statusId.safeParse(single(params, key));
  return parsed.success && parsed.data !== undefined ? parsed.data : '';
}

/** Validated filters from the page URL. Malformed or repeated values are ignored, never rewritten. */
export function readTaskFilterParams(params: URLSearchParams): TaskFilterParams {
  const archived = taskListQuerySchema.shape.includeArchived.safeParse(single(params, filterParam.includeArchived));
  return {
    // Only the exact single `open` narrows; anything else shows all tasks and stays in the URL as it was.
    completion: single(params, filterParam.completion) === 'open' ? 'open' : 'all',
    statusId: readId(params, filterParam.statusId),
    participantMembershipId: readId(params, filterParam.participantMembershipId),
    tagId: readId(params, filterParam.tagId),
    includeArchived: archived.success && archived.data === true,
  };
}

/**
 * Applies only the filters that changed from `before` to `next` onto the current URL `params`, so
 * two quick changes from one render both survive and every unrelated parameter is kept.
 * Returns null when no URL-backed filter changed (a search edit, for example).
 */
export function patchTaskFilterParams(params: URLSearchParams, before: TaskFilterParams, next: TaskFilterParams): URLSearchParams | null {
  const ids = ['statusId', 'participantMembershipId', 'tagId'] as const;
  const changedIds = ids.filter(key => before[key] !== next[key]);
  const archivedChanged = before.includeArchived !== next.includeArchived;
  const completionChanged = before.completion !== next.completion;
  if (changedIds.length === 0 && !archivedChanged && !completionChanged) return null;
  const patched = new URLSearchParams(params);
  if (completionChanged) {
    if (next.completion === 'open') patched.set(filterParam.completion, 'open');
    else patched.delete(filterParam.completion);
  }
  for (const key of changedIds) {
    if (next[key]) patched.set(filterParam[key], next[key]);
    else patched.delete(filterParam[key]);
  }
  if (archivedChanged) {
    if (next.includeArchived) patched.set(filterParam.includeArchived, 'true');
    else patched.delete(filterParam.includeArchived);
  }
  return patched;
}

/** `value` once it has stayed the same for `delayMs`; clearing applies at once. */
export function useDebouncedValue(value: string, delayMs: number): string {
  useTranslation();
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value === '' ? '' : settled;
}

export interface TaskFiltersProps {
  value: TaskFilterValue;
  onChange: (value: TaskFilterValue) => void;
  statuses: readonly TaskStatusDto[];
  members: readonly MembershipDto[];
  tags?: readonly TagDto[];
}

const pickerClassName = 'mt-1.5';
const labelClassName = 'text-sm font-medium text-ink';

export function TaskFilters({ value, onChange, statuses, members, tags = [] }: TaskFiltersProps) {
  const { t, locale } = useTranslation();
  const summaryRef = useRef<HTMLElement>(null);
  const ids = { search: useId(), status: useId(), participant: useId(), tag: useId(), archived: useId(), hint: useId() };
  const orderedStatuses = useMemo(() => [...statuses].sort((a, b) => a.position - b.position), [statuses]);
  const orderedMembers = useMemo(
    () => [...members].sort((a, b) => a.displayName.localeCompare(b.displayName, locale)),
    [members, locale],
  );
  const orderedTags = useMemo(
    () => tags.filter(tag => tag.archivedAt === null).sort((a, b) => a.name.localeCompare(b.name, locale)),
    [tags, locale],
  );
  const selectedTag = tags.find(tag => tag.id === value.tagId);
  const unavailableTag = value.tagId !== '' && !orderedTags.some(tag => tag.id === value.tagId);
  const unavailableStatus = value.statusId !== '' && !statuses.some(status => status.id === value.statusId);
  const unavailableParticipant = value.participantMembershipId !== '' && !members.some(member => member.id === value.participantMembershipId);
  const set = (patch: Partial<TaskFilterValue>) => onChange({ ...value, ...patch });
  // A held choice missing from the catalog stays visible and selected, but cannot be chosen again.
  const statusOptions: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFilters.allStatuses') },
    ...(unavailableStatus ? [{ value: value.statusId, label: t('tasks.taskFilters.statusUnavailable'), disabled: true }] : []),
    ...orderedStatuses.map(status => ({ value: status.id, label: status.name })),
  ];
  const participantOptions: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFilters.allParticipants') },
    ...(unavailableParticipant ? [{ value: value.participantMembershipId, label: t('tasks.taskFilters.participantUnavailable'), disabled: true }] : []),
    ...orderedMembers.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl })),
  ];
  const tagOptions: ChoiceOption[] = [
    { value: '', label: t('tasks.taskFilters.allTags') },
    ...(unavailableTag ? [{ value: value.tagId, label: selectedTag ? t('tasks.taskFields.valueArchived', { p0: selectedTag.name }) : t('tasks.taskFilters.tagUnavailable'), disabled: true }] : []),
    ...orderedTags.map(tag => ({ value: tag.id, label: tag.name, color: tagColor(tag) })),
  ];

  const completionOptions: ChoiceOption[] = [
    { value: 'all', label: t('tasks.taskFilters.allTasks') },
    { value: 'open', label: t('tasks.taskFilters.incompleteTasks') },
  ];

  const activeCount = Number(value.completion === 'open') + Number(value.statusId !== '') + Number(value.participantMembershipId !== '') + Number(value.tagId !== '') + Number(value.includeArchived);
  const selectedStatus = statuses.find(status => status.id === value.statusId)?.name ?? t('filterSummary.statusUnavailable');
  const selectedParticipant = members.find(member => member.id === value.participantMembershipId)?.displayName ?? t('filterSummary.participantUnavailable');
  const selectedTagLabel = selectedTag ? selectedTag.archivedAt === null ? selectedTag.name : t('tasks.taskFields.valueArchived', { p0: selectedTag.name }) : t('tasks.taskFilters.tagUnavailable');
  const summaries = [
    ...(value.completion === 'open' ? [{ key: 'completion', label: t('filterSummary.completion'), clearLabel: t('filterSummary.clearCompletion'), patch: { completion: 'all' as const } }] : []),
    ...(value.statusId ? [{ key: 'status', label: t('filterSummary.status', { value: selectedStatus }), clearLabel: t('filterSummary.clearStatus', { value: selectedStatus }), patch: { statusId: '' } }] : []),
    ...(value.participantMembershipId ? [{ key: 'participant', label: t('filterSummary.participant', { value: selectedParticipant }), clearLabel: t('filterSummary.clearParticipant', { value: selectedParticipant }), patch: { participantMembershipId: '' } }] : []),
    ...(value.tagId ? [{ key: 'tag', label: t('filterSummary.tag', { value: selectedTagLabel }), clearLabel: t('filterSummary.clearTag', { value: selectedTagLabel }), patch: { tagId: '' } }] : []),
    ...(value.includeArchived ? [{ key: 'archived', label: t('filterSummary.archived'), clearLabel: t('filterSummary.clearArchived'), patch: { includeArchived: false } }] : []),
  ];
  return (
    <div className="min-w-0 space-y-2">
    {/* Search keeps a comfortable width; the controls wrap below it, still right-aligned so the Filters panel opens inside the page. */}
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="min-w-0 max-w-full grow basis-60">
        <label htmlFor={ids.search} className="sr-only">{t('tasks.taskFilters.searchTasks')}</label>
        <TextInput id={ids.search} type="search" placeholder={t('tasks.taskFilters.searchTasks')} value={value.search} autoComplete="off" onChange={event => set({ search: event.target.value })} />
      </div>
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
      {/* Separate from the status filter: it narrows by status group, not one status. */}
      <div className="w-40 shrink-0">
        <ChoicePicker compact label={t('tasks.taskFilters.taskCompletion')} value={value.completion} options={completionOptions} onValueChange={completion => set({ completion: completion === 'open' ? 'open' : 'all' })} />
      </div>
      <details className="relative shrink-0" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary ref={summaryRef} className="flex h-9 cursor-pointer list-none items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink-soft hover:bg-canvas [&::-webkit-details-marker]:hidden">{activeCount ? t('tasks.taskFilters.filterCount', { count: activeCount }) : t('tasks.taskFilters.filters')}</summary>
        <div className="absolute right-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-line bg-surface p-4 shadow-lg">
          <div>
            <label htmlFor={ids.status} className={labelClassName}>{t('tasks.taskFilters.taskStatus')}</label>
            <ChoicePicker id={ids.status} label={t('tasks.taskFilters.taskStatus')} className={pickerClassName} value={value.statusId} options={statusOptions} onValueChange={statusId => set({ statusId })} />
          </div>
          <div>
            <label htmlFor={ids.participant} className={labelClassName}>{t('tasks.taskFilters.taskParticipant')}</label>
            <ChoicePicker id={ids.participant} label={t('tasks.taskFilters.taskParticipant')} className={pickerClassName} value={value.participantMembershipId} options={participantOptions} onValueChange={participantMembershipId => set({ participantMembershipId })} />
          </div>
          <div>
            <label htmlFor={ids.tag} className={labelClassName}>{t('tasks.taskFilters.taskTag')}</label>
            <ChoicePicker id={ids.tag} label={t('tasks.taskFilters.taskTag')} className={pickerClassName} value={value.tagId} options={tagOptions} onValueChange={tagId => set({ tagId })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-soft" htmlFor={ids.archived}>
            <input id={ids.archived} type="checkbox" className="size-4 rounded border-line accent-accent" checked={value.includeArchived} onChange={event => set({ includeArchived: event.target.checked })} />
            {t('tasks.taskFilters.showArchivedTasks')}
          </label>
        </div>
      </details>
      {hasActiveTaskFilters(value) ? <Button size="sm" variant="ghost" aria-label={t('tasks.taskFilters.clearFilters')} title={t('tasks.taskFilters.clearFilters')} onClick={() => onChange(emptyTaskFilters)}><X size={16} aria-hidden="true" /></Button> : null}
      </div>
    </div>
    {summaries.length ? <div role="group" aria-label={t('filterSummary.group')} className="flex min-w-0 flex-wrap gap-2">
      {summaries.map(summary => <button key={summary.key} type="button" aria-label={summary.clearLabel} onClick={() => { set(summary.patch); summaryRef.current?.focus(); }} className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-left text-xs text-ink-soft hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">{summary.key === 'tag' && selectedTag ? <TagBadge tag={{ ...selectedTag, name: summary.label, archivedAt: null }} /> : <span className="min-w-0 [overflow-wrap:anywhere]">{summary.label}</span>}<X size={14} aria-hidden="true" className="shrink-0" /></button>)}
    </div> : null}
    </div>
  );
}
