import { useTranslation } from '../../i18n';
import type { MembershipDto, TagDto, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** What the user chose; applied on the server. Search text stays in memory, never in the URL. */
export interface TaskFilterValue {
  search: string;
  statusId: string;
  participantMembershipId: string;
  tagId: string;
  includeArchived: boolean;
}

export const emptyTaskFilters: TaskFilterValue = {
  search: '',
  statusId: '',
  participantMembershipId: '',
  tagId: '',
  includeArchived: false,
};

export function hasActiveTaskFilters(value: TaskFilterValue): boolean {
  return value.search.trim() !== '' || value.statusId !== '' || value.participantMembershipId !== '' || value.tagId !== '' || value.includeArchived;
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

const selectClassName = inputClassName('mt-1.5 pr-8');
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
  const set = (patch: Partial<TaskFilterValue>) => onChange({ ...value, ...patch });

  const activeCount = Number(value.statusId !== '') + Number(value.participantMembershipId !== '') + Number(value.tagId !== '') + Number(value.includeArchived);
  const selectedStatus = statuses.find(status => status.id === value.statusId)?.name ?? t('filterSummary.statusUnavailable');
  const selectedParticipant = members.find(member => member.id === value.participantMembershipId)?.displayName ?? t('filterSummary.participantUnavailable');
  const selectedTagLabel = selectedTag ? selectedTag.archivedAt === null ? selectedTag.name : t('tasks.taskFields.valueArchived', { p0: selectedTag.name }) : t('tasks.taskFilters.tagUnavailable');
  const summaries = [
    ...(value.statusId ? [{ key: 'status', label: t('filterSummary.status', { value: selectedStatus }), clearLabel: t('filterSummary.clearStatus', { value: selectedStatus }), patch: { statusId: '' } }] : []),
    ...(value.participantMembershipId ? [{ key: 'participant', label: t('filterSummary.participant', { value: selectedParticipant }), clearLabel: t('filterSummary.clearParticipant', { value: selectedParticipant }), patch: { participantMembershipId: '' } }] : []),
    ...(value.tagId ? [{ key: 'tag', label: t('filterSummary.tag', { value: selectedTagLabel }), clearLabel: t('filterSummary.clearTag', { value: selectedTagLabel }), patch: { tagId: '' } }] : []),
    ...(value.includeArchived ? [{ key: 'archived', label: t('filterSummary.archived'), clearLabel: t('filterSummary.clearArchived'), patch: { includeArchived: false } }] : []),
  ];
  return (
    <div className="min-w-0 space-y-2">
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={ids.search} className="sr-only">{t('tasks.taskFilters.searchTasks')}</label>
        <TextInput id={ids.search} type="search" placeholder={t('tasks.taskFilters.searchTasks')} value={value.search} autoComplete="off" onChange={event => set({ search: event.target.value })} />
      </div>
      <details className="relative shrink-0" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary ref={summaryRef} className="flex h-9 cursor-pointer list-none items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink-soft hover:bg-canvas [&::-webkit-details-marker]:hidden">{activeCount ? t('tasks.taskFilters.filterCount', { count: activeCount }) : t('tasks.taskFilters.filters')}</summary>
        <div className="absolute right-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-line bg-surface p-4 shadow-lg">
          <div>
            <label htmlFor={ids.status} className={labelClassName}>{t('tasks.taskFilters.taskStatus')}</label>
            <select id={ids.status} className={selectClassName} value={value.statusId} onChange={event => set({ statusId: event.target.value })}>
              <option value="">{t('tasks.taskFilters.allStatuses')}</option>
              {orderedStatuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={ids.participant} className={labelClassName}>{t('tasks.taskFilters.taskParticipant')}</label>
            <select id={ids.participant} className={selectClassName} value={value.participantMembershipId} onChange={event => set({ participantMembershipId: event.target.value })}>
              <option value="">{t('tasks.taskFilters.allParticipants')}</option>
              {orderedMembers.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={ids.tag} className={labelClassName}>{t('tasks.taskFilters.taskTag')}</label>
            <select id={ids.tag} className={selectClassName} value={value.tagId} onChange={event => set({ tagId: event.target.value })}>
              <option value="">{t('tasks.taskFilters.allTags')}</option>
              {unavailableTag ? <option value={value.tagId}>{selectedTag ? t('tasks.taskFields.valueArchived', { p0: selectedTag.name }) : t('tasks.taskFilters.tagUnavailable')}</option> : null}
              {orderedTags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-soft" htmlFor={ids.archived}>
            <input id={ids.archived} type="checkbox" className="size-4 rounded border-line accent-accent" checked={value.includeArchived} onChange={event => set({ includeArchived: event.target.checked })} />
            {t('tasks.taskFilters.showArchivedTasks')}
          </label>
        </div>
      </details>
      {hasActiveTaskFilters(value) ? <Button size="sm" variant="ghost" aria-label={t('tasks.taskFilters.clearFilters')} title={t('tasks.taskFilters.clearFilters')} onClick={() => onChange(emptyTaskFilters)}><X size={16} aria-hidden="true" /></Button> : null}
    </div>
    {summaries.length ? <div role="group" aria-label={t('filterSummary.group')} className="flex min-w-0 flex-wrap gap-2">
      {summaries.map(summary => <button key={summary.key} type="button" aria-label={summary.clearLabel} onClick={() => { set(summary.patch); summaryRef.current?.focus(); }} className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-left text-xs text-ink-soft hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"><span className="min-w-0 [overflow-wrap:anywhere]">{summary.label}</span><X size={14} aria-hidden="true" className="shrink-0" /></button>)}
    </div> : null}
    </div>
  );
}
