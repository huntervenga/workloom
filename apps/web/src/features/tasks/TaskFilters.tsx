import { useTranslation } from '../../i18n';
import type { MembershipDto, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

/** What the user chose; applied on the server. Search text stays in memory, never in the URL. */
export interface TaskFilterValue {
  search: string;
  statusId: string;
  participantMembershipId: string;
  includeArchived: boolean;
}

export const emptyTaskFilters: TaskFilterValue = {
  search: '',
  statusId: '',
  participantMembershipId: '',
  includeArchived: false,
};

export function hasActiveTaskFilters(value: TaskFilterValue): boolean {
  return value.search.trim() !== '' || value.statusId !== '' || value.participantMembershipId !== '' || value.includeArchived;
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
}

const selectClassName = inputClassName('mt-1.5 pr-8');
const labelClassName = 'text-sm font-medium text-ink';

export function TaskFilters({ value, onChange, statuses, members }: TaskFiltersProps) {
  const { t, locale } = useTranslation();
  const ids = { search: useId(), status: useId(), participant: useId(), archived: useId(), hint: useId() };
  const orderedStatuses = useMemo(() => [...statuses].sort((a, b) => a.position - b.position), [statuses]);
  const orderedMembers = useMemo(
    () => [...members].sort((a, b) => a.displayName.localeCompare(b.displayName, locale)),
    [members, locale],
  );
  const set = (patch: Partial<TaskFilterValue>) => onChange({ ...value, ...patch });

  const activeCount = Number(value.statusId !== '') + Number(value.participantMembershipId !== '') + Number(value.includeArchived);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={ids.search} className="sr-only">{t('tasks.taskFilters.searchTasks')}</label>
        <TextInput id={ids.search} type="search" placeholder={t('tasks.taskFilters.searchTasks')} value={value.search} autoComplete="off" onChange={event => set({ search: event.target.value })} />
      </div>
      <details className="relative shrink-0" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary className="flex h-9 cursor-pointer list-none items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink-soft hover:bg-canvas [&::-webkit-details-marker]:hidden">{activeCount ? t('tasks.taskFilters.filterCount', { count: activeCount }) : t('tasks.taskFilters.filters')}</summary>
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
          <label className="flex items-center gap-2 text-sm text-ink-soft" htmlFor={ids.archived}>
            <input id={ids.archived} type="checkbox" className="size-4 rounded border-line accent-accent" checked={value.includeArchived} onChange={event => set({ includeArchived: event.target.checked })} />
            {t('tasks.taskFilters.showArchivedTasks')}
          </label>
        </div>
      </details>
      {hasActiveTaskFilters(value) ? <Button size="sm" variant="ghost" aria-label={t('tasks.taskFilters.clearFilters')} title={t('tasks.taskFilters.clearFilters')} onClick={() => onChange(emptyTaskFilters)}><X size={16} aria-hidden="true" /></Button> : null}
    </div>
  );
}
