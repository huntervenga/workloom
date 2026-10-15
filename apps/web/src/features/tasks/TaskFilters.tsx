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
  const ids = { search: useId(), status: useId(), participant: useId(), archived: useId(), hint: useId() };
  const orderedStatuses = useMemo(() => [...statuses].sort((a, b) => a.position - b.position), [statuses]);
  const orderedMembers = useMemo(
    () => [...members].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru')),
    [members],
  );
  const set = (patch: Partial<TaskFilterValue>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div>
          <label htmlFor={ids.search} className={labelClassName}>
            Поиск задач
          </label>
          <TextInput
            id={ids.search}
            type="search"
            className="mt-1.5"
            value={value.search}
            autoComplete="off"
            onChange={(event) => set({ search: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor={ids.status} className={labelClassName}>
            Статус задач
          </label>
          <select
            id={ids.status}
            className={selectClassName}
            value={value.statusId}
            onChange={(event) => set({ statusId: event.target.value })}
          >
            <option value="">Все статусы</option>
            {orderedStatuses.map((status) => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={ids.participant} className={labelClassName}>
            Участник задач
          </label>
          <select
            id={ids.participant}
            className={selectClassName}
            aria-describedby={ids.hint}
            value={value.participantMembershipId}
            onChange={(event) => set({ participantMembershipId: event.target.value })}
          >
            <option value="">Все участники</option>
            {orderedMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <input
            id={ids.archived}
            type="checkbox"
            className="size-4 rounded border-line accent-accent"
            checked={value.includeArchived}
            onChange={(event) => set({ includeArchived: event.target.checked })}
          />
          <label htmlFor={ids.archived} className="text-sm text-ink-soft">
            Показывать архивные задачи
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={ids.hint} className="text-sm text-muted">
          Оценки показывают общий объём работы команды.
        </p>
        {hasActiveTaskFilters(value) ? (
          <Button size="sm" onClick={() => onChange(emptyTaskFilters)}>
            <X size={16} aria-hidden="true" />
            Сбросить фильтры
          </Button>
        ) : null}
      </div>
    </div>
  );
}
