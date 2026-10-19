import * as Menu from '@radix-ui/react-dropdown-menu';
import { createTaskFieldInputSchema, taskFieldTypeSchema, type ProjectColumnsDto, type TaskFieldDefinitionDto, type TaskFieldType, type TaskTableBuiltinColumn } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { Check, ChevronDown, Columns3, Plus, Settings2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation, type TranslationKey } from '../../i18n';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FieldManagerDialog } from '../fields/FieldManagerDialog';
import { FIELD_NAME_MAX, FIELDS_SAVE_SUBJECT, fieldTypeLabels, isSelectType, sentCommand } from '../fields/FieldDefinitionForm';
import { useCreateTaskFieldMutation } from '../fields/queries';
import { CellPopover } from '../tasks/CellPopover';
import { columnKey, isLegacyTimeColumn, reconcilePersonalColumns } from './personalColumns';
import type { PersonalTablePreferenceController } from './usePersonalTablePreference';

const labels = {
  title: 'taskTable.taskTable.task2', status: 'taskTable.taskTable.status', responsible: 'taskTable.taskTable.assignee',
  participants: 'taskTable.taskTable.participants', dueDate: 'taskTable.taskTable.dueDate', tags: 'taskTable.taskTable.tags',
  priority: 'taskTable.taskTable.priority', estimate: 'taskTable.taskTable.teamEstimate',
  weeklyPlan: 'taskTable.personalColumns.weeklyPlan', weeklyActual: 'taskTable.personalColumns.weeklyActual',
} satisfies Record<TaskTableBuiltinColumn, TranslationKey>;
const itemClass = 'relative flex min-h-8 cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-canvas data-[disabled]:opacity-40';

export interface TableColumnMenuProps {
  actorId: string;
  workspaceId: string;
  projectId: string;
  canManage: boolean;
  controller: PersonalTablePreferenceController;
  fields: readonly TaskFieldDefinitionDto[];
  projectColumns: ProjectColumnsDto | undefined;
  timeAvailable: boolean;
  catalogError: unknown;
}

/** Fast column choices live on the grid; definition writes outlive the popover and retain retry identity. */
export function TableColumnMenu({ actorId, workspaceId, projectId, canManage, controller: c, fields, projectColumns, timeAvailable, catalogError }: TableColumnMenuProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<TaskFieldType>('text');
  const [options, setOptions] = useState('');
  const [history, setHistory] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId(); const typeId = useId(); const optionsId = useId();
  const create = useCreateTaskFieldMutation(actorId, workspaceId);
  const held = sentCommand(create);
  const frozen = held !== null;
  const shown = held?.variables.input;
  const shownType = shown?.type ?? type;
  const stored = c.held?.variables.input.columns ?? c.draft?.columns ?? c.query.data?.columns ?? null;
  const result = projectColumns ? reconcilePersonalColumns(stored, fields, projectColumns, timeAvailable) : null;
  const ownFields = new Map(fields.filter(field => field.workspaceId === workspaceId && field.projectId === projectId).map(field => [field.id.toLowerCase(), field]));
  const choices = (result?.choices ?? []).flatMap((choice, index) => {
    const ref = choice.column;
    if (isLegacyTimeColumn(ref)) return [];
    const field = ref.kind === 'field' ? ownFields.get(ref.fieldId.toLowerCase()) : undefined;
    if (ref.kind === 'field' && (!field || field.archivedAt !== null)) return [];
    return [{ choice, index, name: ref.kind === 'builtin' ? t(labels[ref.key]) : field?.name ?? '' }];
  });
  const columnsBlocked = c.frozen || c.draft !== null || !c.query.data || !result || result.limitExceeded || result.invalidRefs.length > 0 || Boolean(catalogError);
  const close = () => { setCreating(false); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!creating) return undefined;
    nameRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest('[data-column-type-menu]'))) setCreating(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); setCreating(false); triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [creating]);
  const added = (field: TaskFieldDefinitionDto) => {
    setCreating(false); setName(''); setOptions(''); setInvalid(false);
    setNotice(t('taskTable.columnMenu.created', { name: field.name }));
    triggerRef.current?.focus();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (!canManage || frozen) return;
    const input = { projectId, name: name.trim(), type, historyEnabled: history, locked: false,
      options: isSelectType(type) ? options.split('\n').map(value => value.trim()).filter(Boolean).map(value => ({ name: value, color: null })) : [] };
    if (!createTaskFieldInputSchema.safeParse(input).success) { setInvalid(true); nameRef.current?.focus(); return; }
    setInvalid(false); create.mutate({ input }, { onSuccess: added });
  };
  return <div ref={wrapperRef} className="flex items-center justify-center">
    <Menu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <Menu.Trigger asChild><button ref={triggerRef} type="button" aria-label={t('taskTable.columnMenu.trigger')} title={t('taskTable.columnMenu.trigger')} className="inline-flex size-7 items-center justify-center rounded text-muted outline-none hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"><Plus size={16} aria-hidden="true" /></button></Menu.Trigger>
      <Menu.Portal><Menu.Content onCloseAutoFocus={event => { if (creating || managerOpen) event.preventDefault(); }} align="end" sideOffset={5} className="z-[80] max-h-[min(70dvh,34rem)] w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-xl">
        {canManage ? <Menu.Item className={itemClass} onSelect={() => { setCreating(true); setNotice(null); }}><Plus size={15} aria-hidden="true" />{t(held ? 'taskTable.columnMenu.resume' : 'taskTable.columnMenu.create')}</Menu.Item> : null}
        <Menu.Label className="px-2 pt-2 pb-1 text-xs font-medium text-muted">{t('taskTable.columnMenu.visible')}</Menu.Label>
        {choices.map(({ choice, index, name: columnName }) => <Menu.CheckboxItem key={columnKey(choice.column)} checked={choice.visible} disabled={columnsBlocked || choice.column.kind === 'builtin' && choice.column.key === 'title'} onSelect={event => event.preventDefault()} onCheckedChange={visible => {
          if (columnsBlocked || !result) return;
          const next = result.choices.map((item, at) => at === index ? { ...item, visible } : item);
          c.setDraft(next); c.save(next);
        }} className={itemClass}><span className="inline-flex size-4 shrink-0 items-center justify-center"><Menu.ItemIndicator><Check size={14} aria-hidden="true" /></Menu.ItemIndicator></span><span className="truncate">{columnName}</span></Menu.CheckboxItem>)}
        {c.held || c.head === 'loading' ? <Menu.Label className="px-2 py-1 text-xs text-muted">{t('taskTable.columnMenu.saving')}</Menu.Label> : null}
        <Menu.Separator className="my-1 h-px bg-line" />
        <Menu.Item className={itemClass} onSelect={() => c.setOpen(true)}><Columns3 size={15} aria-hidden="true" />{t(c.draft || c.command.error || c.head === 'failed' ? 'taskTable.personalColumns.reviewColumns' : 'taskTable.columnMenu.order')}</Menu.Item>
        {canManage ? <Menu.Item className={itemClass} onSelect={() => setManagerOpen(true)}><Settings2 size={15} aria-hidden="true" />{t('taskTable.columnMenu.settings')}</Menu.Item> : null}
        <Menu.Label className="px-2 py-1 text-xs leading-relaxed text-muted">{t('taskTable.columnMenu.visibilityHint')}</Menu.Label>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
    {creating ? <CellPopover anchor={triggerRef.current} role="dialog" ariaLabel={t('taskTable.columnMenu.create')} className="w-80 max-w-[calc(100vw-1rem)] p-3">
      <form onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); } }} className="space-y-3">
        <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-ink">{t('taskTable.columnMenu.create')}</span><button type="button" onClick={close} aria-label={t('taskTable.columnMenu.close')} className="rounded p-1 text-muted hover:bg-canvas"><X size={14} aria-hidden="true" /></button></div>
        <div><label htmlFor={nameId} className="mb-1 block text-xs text-muted">{t('taskTable.columnMenu.name')}</label><TextInput ref={nameRef} id={nameId} autoComplete="off" maxLength={FIELD_NAME_MAX} readOnly={frozen} value={shown?.name ?? name} onChange={event => { setName(event.target.value); setInvalid(false); }} /></div>
        <div><span id={typeId} className="mb-1 block text-xs text-muted">{t('taskTable.columnMenu.type')}</span><Menu.Root modal={false}><Menu.Trigger asChild><button type="button" disabled={frozen} aria-labelledby={typeId} className="flex h-9 w-full items-center justify-between rounded-lg border border-line px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">{fieldTypeLabels[shownType]}<ChevronDown size={14} aria-hidden="true" /></button></Menu.Trigger><Menu.Content data-column-type-menu="" align="start" sideOffset={4} className="z-[100] w-64 rounded-xl border border-line bg-surface p-1 shadow-xl">{taskFieldTypeSchema.options.map(value => <Menu.Item key={value} className={itemClass} onSelect={() => setType(value)}>{fieldTypeLabels[value]}{value === shownType ? <Check size={14} aria-hidden="true" className="ml-auto" /> : null}</Menu.Item>)}</Menu.Content></Menu.Root></div>
        {isSelectType(shownType) ? <div><label htmlFor={optionsId} className="mb-1 block text-xs text-muted">{t('taskTable.columnMenu.options')}</label><textarea id={optionsId} rows={3} readOnly={frozen} value={shown ? shown.options.map(option => option.name).join('\n') : options} onChange={event => setOptions(event.target.value)} className="w-full resize-y rounded-lg border border-line bg-surface p-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" /></div> : null}
        <label className="flex items-center gap-2 text-xs text-ink-soft"><input type="checkbox" disabled={frozen} checked={shown?.historyEnabled ?? history} onChange={event => setHistory(event.target.checked)} />{t('taskTable.columnMenu.history')}</label>
        {invalid ? <p role="alert" className="text-xs text-red-700">{t('taskTable.columnMenu.invalid')}</p> : null}
        <SaveFeedback subject={FIELDS_SAVE_SUBJECT} error={create.error} uncertainError={create.uncertain?.error ?? null} />
        {create.uncertain ? <Button type="button" size="sm" variant="primary" disabled={create.pendingCommand !== null} onClick={() => create.retryUncertain({ onSuccess: added })}>{t('taskTable.columnMenu.retry')}</Button> : <Button type="submit" size="sm" variant="primary" disabled={frozen || !canManage}>{t(frozen ? 'taskTable.columnMenu.saving' : 'taskTable.columnMenu.add')}</Button>}
      </form>
    </CellPopover> : null}
    {notice ? <span role="status" className="sr-only">{notice}</span> : null}
    <FieldManagerDialog actorId={actorId} workspaceId={workspaceId} projectId={projectId} canManage={canManage} open={managerOpen} onOpenChange={setManagerOpen} showTrigger={false} />
  </div>;
}
