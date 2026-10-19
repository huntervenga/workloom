import type { MembershipDto } from '@workloom/contracts';
import { X } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { UserAvatar } from '../../shared/UserAvatar';

/** Selected people stay compact; the searchable menu scales without rendering a roster. */
export function TaskParticipantPicker({ members, value, retainedIds, disabled = false, onChange }: {
  members: readonly MembershipDto[];
  value: readonly string[];
  retainedIds: readonly string[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const selected = new Set(value);
  const available = members.filter(member => !selected.has(member.id));
  const unavailable = retainedIds.filter(id => !selected.has(id) && !members.some(member => member.id === id));
  return <div role="group" aria-label={t('tasks.taskFields.participants')} className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5">
    {value.map(id => {
      const member = members.find(candidate => candidate.id === id);
      const name = member?.displayName ?? t('tasks.taskFields.memberUnavailable');
      return <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pr-1 pl-0.5 text-sm text-ink-soft">
        <UserAvatar name={name} seed={id} avatarUrl={member?.avatarUrl} size="sm" />
        <span className="truncate">{name}</span>
        <button type="button" disabled={disabled} aria-label={t('tasks.taskFields.removeParticipant', { name })}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-ink disabled:opacity-40"
          onClick={() => onChange(value.filter(candidate => candidate !== id))}><X size={12} aria-hidden="true" /></button>
      </span>;
    })}
    <ChoicePicker label={t('tasks.taskFields.addParticipant')} value="" compact searchable disabled={disabled}
      className="border-transparent! bg-transparent! px-1.5 shadow-none! hover:bg-canvas!"
      options={[{ value: '', label: t('tasks.taskFields.addParticipant') },
        ...available.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl })),
        ...unavailable.map(id => ({ value: id, label: t('tasks.taskFields.memberUnavailable') }))]}
      onValueChange={id => { if (id !== '' && !selected.has(id)) onChange([...value, id]); }} />
  </div>;
}
