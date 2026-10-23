import type { MembershipDto, TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { FieldValueDisplay } from './FieldValueDisplay';
import { BooleanFieldControl } from './BooleanFieldControl';
import { clearedFieldDraft, draftFromFieldValue, NOT_SET, optionsByPosition, referenceLabels, sameId, type FieldDraft } from './valueDraft';

/** The same fixed-height, non-modal value editor in a row, a selection, or the task pane. */
/** A value computed from subtasks: muted and italic so it is never mistaken for something typed in. */
export function CalculatedValue({ field, data, members }: { field: TaskFieldDefinitionDto; data: TaskFieldData; members: readonly MembershipDto[] }) {
  const { t } = useTranslation();
  return <span className="min-w-0 truncate italic text-muted" title={t('inlineFields.calculatedFromSubtasks')} data-calculated-from-subtasks=""><FieldValueDisplay field={field} value={data} members={members} compact /><span className="sr-only"> {t('inlineFields.calculatedFromSubtasks')}</span></span>;
}

export function FieldCellControl({ field, value, members, label, disabled, draft, error, inherited, onBegin, onChange, onCommit, onCancel }: {
  field: TaskFieldDefinitionDto; value: TaskFieldData | null; members: readonly MembershipDto[];
  /** Sum of subtask values shown, in a muted style, while the task's own value is unset. */
  inherited?: TaskFieldData | null | undefined;
  label: string; disabled: boolean; draft?: FieldDraft; error?: string | null;
  onBegin: () => void; onChange: (draft: FieldDraft) => void; onCommit: (draft: FieldDraft) => boolean; onCancel: (onlyClean?: boolean) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const current = draft ?? draftFromFieldValue(field, value);
  const begin = () => { if (!disabled) onBegin(); };
  const pick = (next: FieldDraft) => { onChange(next); onCommit(next); };
  const classes = 'flex h-8 w-full min-w-0 items-center rounded-sm border border-transparent bg-transparent px-1.5 text-left text-sm outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';
  let options: ChoiceOption[] | null = null;
  let chosen = '\u0000none';
  let placeholder = '';
  if (current.type === 'single_select') {
    chosen = current.value?.toLowerCase() ?? '\u0000none';
    const active = optionsByPosition(field.options).filter(option => option.archivedAt === null);
    const storedId = current.value;
    const retained = storedId && !active.some(option => sameId(option.id, storedId)) ? referenceLabels(field, [storedId], members) : [];
    options = [{ value: '', label: NOT_SET() }, ...retained.map(option => ({ value: option.id.toLowerCase(), label: option.label, color: option.color ?? undefined, disabled: true })), ...active.map(option => ({ value: option.id.toLowerCase(), label: option.name, color: option.color ?? undefined }))];
  } else if (current.type === 'boolean') {
    return <BooleanFieldControl value={current.value} label={label} fieldName={field.name} disabled={disabled} invalid={Boolean(error)} onCancel={() => onCancel(true)}
      onChange={value => pick({ type: 'boolean', value })}/>;
  } else if (current.type === 'multi_select' || current.type === 'person') {
    const ids = current.value ?? [];
    placeholder = referenceLabels(field, ids, members).map(option => option.label).join(', ');
    if (ids.length === 0 && current.value !== null) placeholder = t('fields.valueDraft.nothingSelected');
    const selected = (id: string) => ids.some(value => sameId(id, value));
    const available = current.type === 'person'
      ? members.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarSeed: member.userId, avatarUrl: member.avatarUrl }))
      : optionsByPosition(field.options).filter(option => option.archivedAt === null).map(option => ({ value: option.id, label: option.name, color: option.color ?? undefined }));
    options = [{ value: '', label: NOT_SET() }, ...available.map(option => ({ ...option, value: option.value.toLowerCase(), description: selected(option.value) ? t('inlineFields.selectedChoice') : undefined }))];
    // Retained references remain visible in the trigger and cannot accidentally be re-selected.
    options.push(...referenceLabels(field, ids.filter(id => !available.some(option => sameId(option.value, id))), members).map(option => ({ value: option.id.toLowerCase(), label: option.label, disabled: true })));
  }
  if (options) return <div className="min-w-0 flex-1">
    <ChoicePicker onOpenChange={open => { if (open) begin(); else onCancel(true); }} compact label={label} value={chosen} options={options} placeholder={placeholder} searchable={current.type === 'person' || current.type === 'multi_select' ? true : undefined} disabled={disabled}
      className="border-transparent! bg-transparent! px-1.5 shadow-none! hover:bg-canvas!"
      onValueChange={choice => {
        if (current.type === 'single_select') pick({ type: current.type, value: choice === '' ? null : field.options.find(option => sameId(option.id, choice))?.id ?? choice });
        else if (current.type === 'person' || current.type === 'multi_select') {
          const values = current.value ?? [];
          const canonical = current.type === 'person' ? members.find(member => sameId(member.id, choice))?.id : field.options.find(option => sameId(option.id, choice))?.id;
          pick({ type: current.type, value: choice === '' ? null : values.some(id => sameId(id, choice)) ? values.filter(id => !sameId(id, choice)) : [...values, canonical ?? choice] });
        }
      }} />
  </div>;
  const text = current.type === 'text' ? current.value ?? '' : 'text' in current ? current.text : '';
  if (editing) return <div className="flex h-8 min-w-0 flex-1 items-center"><input autoFocus aria-invalid={error ? true : undefined} aria-label={label} disabled={disabled} className={`${classes} border-accent! bg-surface!`} value={text} inputMode={current.type === 'number' || current.type === 'duration' ? 'decimal' : undefined}
    onFocus={event => event.currentTarget.select()}
    onChange={event => onChange(current.type === 'text' ? { type: 'text', value: event.target.value } : { type: current.type as 'number' | 'duration' | 'date' | 'url', text: event.target.value })}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setEditing(false); onCancel(); }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); const saved = onCommit(current); cancelled.current = saved !== false; if (saved !== false) setEditing(false); }
    }}
    onBlur={() => { const saved = cancelled.current ? true : onCommit(current); cancelled.current = false; if (saved !== false) setEditing(false); }} />
    <button type="button" disabled={disabled} aria-label={t('fields.fieldInput.clearValue', { p0: field.name })} className="h-7 shrink-0 px-1 text-muted hover:text-ink" onMouseDown={event => event.preventDefault()} onClick={() => { const empty = clearedFieldDraft(field); onChange(empty); const saved = onCommit(empty); cancelled.current = saved !== false; if (saved !== false) setEditing(false); }}>×</button>
  </div>;
  return <button type="button" aria-label={label} disabled={disabled} className={classes} onClick={() => { cancelled.current = false; begin(); setEditing(true); }}>
    {value?.type === 'url' ? <span className="truncate">{value.value}</span> : inherited && (value === null || value.value === null) ? <CalculatedValue field={field} data={inherited} members={members} /> : <FieldValueDisplay field={field} value={value} members={members} compact />}
  </button>;
}
