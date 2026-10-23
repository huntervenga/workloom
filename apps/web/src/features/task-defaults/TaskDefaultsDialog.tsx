import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { MembershipDto, TagDto, TaskDefaultsDto, TaskFieldDefinitionDto, TaskPriority, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FieldInput } from '../fields/FieldInput';
import { clearedFieldDraft, draftFromFieldValue, isClearedDraft, parseFieldDraft, type FieldDraft } from '../fields/valueDraft';
import { useTaskFieldsQuery } from '../fields';
import { useMembershipsQuery } from '../workspace/queries';
import { useStatusesQuery } from '../projects/queries';
import { useTagsQuery } from '../tasks/queries';
import { formatEstimate, parseEstimateInput } from '../task-table/estimate';
import { useSaveTaskDefaults, useTaskDefaults } from './queries';

const PRIORITIES: readonly TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];

export function TaskDefaultsDialog({ actorId, workspaceId, projectId, canManage }: { actorId: string; workspaceId: string; projectId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><SlidersHorizontal size={16} aria-hidden="true" />{t('taskDefaults.open')}</Button>
    {open ? <DefaultsEditor actorId={actorId} workspaceId={workspaceId} projectId={projectId} onClose={() => setOpen(false)} /> : null}
  </>;
}

function DefaultsEditor({ actorId, workspaceId, projectId, onClose }: { actorId: string; workspaceId: string; projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const defaults = useTaskDefaults(actorId, workspaceId, projectId);
  const fields = useTaskFieldsQuery(actorId, workspaceId, projectId);
  const statuses = useStatusesQuery(actorId, workspaceId, projectId);
  const members = useMembershipsQuery(actorId, workspaceId);
  const tags = useTagsQuery(actorId, workspaceId);
  // Hosted here, not in the form: closing the dialog must not forget a save whose outcome is unknown.
  const save = useSaveTaskDefaults(actorId, workspaceId, projectId, onClose);
  const holding = save.pendingCommand !== null || save.uncertain !== null;
  const ready = defaults.isSuccess && fields.isSuccess && statuses.isSuccess;
  return <DialogShell open variant="wide" onOpenChange={next => { if (!next && !holding) onClose(); }} title={t('taskDefaults.title')} description={t('taskDefaults.description')}>
    {ready ? <Form key={defaults.data.revision} saved={defaults.data} fields={fields.data.filter(field => field.archivedAt === null && !field.locked)} statuses={statuses.data} members={members.data ?? []} tags={(tags.data ?? []).filter(tag => tag.archivedAt === null)}
        save={save} holding={holding} onClose={onClose} />
      : defaults.isError || fields.isError || statuses.isError ? <p role="alert" className="text-sm text-danger">{t('taskDefaults.loadFailed')}</p>
      : <p role="status" className="text-sm text-muted">{t('taskDefaults.loading')}</p>}
  </DialogShell>;
}

function Form({ saved, fields, statuses, members, tags, save, holding, onClose }: {
  saved: TaskDefaultsDto; fields: readonly TaskFieldDefinitionDto[]; statuses: readonly TaskStatusDto[]; members: readonly MembershipDto[]; tags: readonly TagDto[];
  save: ReturnType<typeof useSaveTaskDefaults>; holding: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const config = saved.config;
  const [statusId, setStatusId] = useState(config.statusId ?? '');
  const [priority, setPriority] = useState<string>(config.priority ?? '');
  const [estimate, setEstimate] = useState(config.estimateMinutes === null ? '' : formatEstimate(config.estimateMinutes));
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() => Object.fromEntries(fields.map(field => {
    const stored = config.fieldValues.find(item => item.fieldId.toLowerCase() === field.id.toLowerCase());
    return [field.id, stored ? draftFromFieldValue(field, stored.value) : clearedFieldDraft(field)];
  })));
  const [problem, setProblem] = useState<string | null>(null);
  const [priorityAbove, setPriorityAbove] = useState(config.fromAbove?.priority === true);
  const [estimateAbove, setEstimateAbove] = useState(config.fromAbove?.estimate === true);
  const [assigneeMode, setAssigneeMode] = useState<'none' | 'above' | 'fixed'>(config.assignee?.kind ?? 'none');
  const [assigneeId, setAssigneeId] = useState(config.assignee?.kind === 'fixed' ? config.assignee.membershipId : '');
  const [tagsMode, setTagsMode] = useState<'none' | 'above' | 'fixed'>(config.tags?.kind ?? 'none');
  const [tagIds, setTagIds] = useState<string[]>(config.tags?.kind === 'fixed' ? config.tags.tagIds : []);
  const [dueMode, setDueMode] = useState<'none' | 'today' | 'above'>(config.dueDate?.kind ?? 'none');
  const [dueOffset, setDueOffset] = useState(String(config.dueDate?.kind === 'today' ? config.dueDate.offsetDays : 0));
  type Source = 'fixed' | 'above' | 'today';
  const [sources, setSources] = useState<Record<string, Source>>(() => Object.fromEntries(fields.map(field => {
    const id = field.id.toLowerCase();
    const source: Source = config.fromAbove?.fieldIds.some(item => item.toLowerCase() === id) ? 'above' : config.todayFields?.some(item => item.fieldId.toLowerCase() === id) ? 'today' : 'fixed';
    return [field.id, source];
  })));
  const [offsets, setOffsets] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(field => [field.id, String(config.todayFields?.find(item => item.fieldId.toLowerCase() === field.id.toLowerCase())?.offsetDays ?? 0)])));

  function submit() {
    const parsedEstimate = estimate.trim() === '' ? { valid: true as const, minutes: null } : parseEstimateInput(estimate);
    if (!parsedEstimate.valid) { setProblem(parsedEstimate.message); return; }
    const fieldValues: TaskDefaultsDto['config']['fieldValues'] = [];
    const aboveIds: string[] = [], todayFields: { fieldId: string; offsetDays: number }[] = [];
    const days = (text: string) => { const n = Number(text); return Number.isInteger(n) && n >= 0 && n <= 366 ? n : null; };
    for (const field of fields) {
      const source = sources[field.id] ?? 'fixed';
      if (source === 'above') { aboveIds.push(field.id); continue; }
      if (source === 'today') {
        const offsetDays = days(offsets[field.id] ?? '0');
        if (offsetDays === null) { setProblem(t('taskDefaults.daysInvalid')); return; }
        todayFields.push({ fieldId: field.id, offsetDays });
        continue;
      }
      const draft = drafts[field.id];
      if (!draft || isClearedDraft(draft)) continue;
      const parsed = parseFieldDraft(field, draft);
      if (!parsed.ok) { setProblem(`${field.name}: ${parsed.message}`); return; }
      if (parsed.value.value === null) continue;
      fieldValues.push({ fieldId: field.id, value: parsed.value });
    }
    const dueDays = days(dueOffset);
    if (dueMode === 'today' && dueDays === null) { setProblem(t('taskDefaults.daysInvalid')); return; }
    if (assigneeMode === 'fixed' && !assigneeId) { setProblem(t('taskDefaults.pickPerson')); return; }
    setProblem(null);
    const fromAbove = priorityAbove || estimateAbove || aboveIds.length > 0 ? { priority: priorityAbove, estimate: estimateAbove, fieldIds: aboveIds } : undefined;
    save.mutate({ input: { expectedRevision: saved.revision, config: {
      statusId: statusId || null, priority: (priority || null) as TaskPriority | null, estimateMinutes: parsedEstimate.minutes, fieldValues,
      ...(assigneeMode === 'none' ? {} : { assignee: assigneeMode === 'above' ? { kind: 'above' as const } : { kind: 'fixed' as const, membershipId: assigneeId } }),
      ...(tagsMode === 'none' ? {} : { tags: tagsMode === 'above' ? { kind: 'above' as const } : { kind: 'fixed' as const, tagIds } }),
      ...(dueMode === 'none' ? {} : { dueDate: dueMode === 'above' ? { kind: 'above' as const } : { kind: 'today' as const, offsetDays: dueDays ?? 0 } }),
      ...(fromAbove ? { fromAbove } : {}),
      ...(todayFields.length > 0 ? { todayFields } : {}),
    } } });
  }

  const selectClass = 'h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink';
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); submit(); }}>
    <fieldset disabled={save.pendingCommand !== null} className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3" aria-label={t('taskDefaults.builtIn')}>
        <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.status')}
          <select className={selectClass} value={statusId} onChange={event => setStatusId(event.target.value)}>
            <option value="">{t('taskDefaults.noDefault')}</option>
            {[...statuses].sort((a, b) => a.position - b.position).map(status => <option key={status.id} value={status.id}>{status.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.priority')}
          <select className={selectClass} value={priority} onChange={event => setPriority(event.target.value)}>
            <option value="">{t('taskDefaults.noDefault')}</option>
            {PRIORITIES.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.estimate')}
          <TextInput value={estimate} placeholder={t('taskDefaults.estimatePlaceholder')} onChange={event => setEstimate(event.target.value)} />
        </label>
      </section>
      <section className="space-y-3" aria-label={t('taskDefaults.sameAsAbove')}>
        <h3 className="text-sm font-medium text-ink">{t('taskDefaults.peopleDates')}</h3>
        <p className="text-xs text-muted">{t('taskDefaults.aboveHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.assignee')}
            <select className={selectClass} value={assigneeMode} onChange={event => setAssigneeMode(event.target.value as typeof assigneeMode)}>
              <option value="none">{t('taskDefaults.noDefault')}</option>
              <option value="above">{t('taskDefaults.fromAbove')}</option>
              <option value="fixed">{t('taskDefaults.specificPerson')}</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.tags')}
            <select className={selectClass} value={tagsMode} onChange={event => setTagsMode(event.target.value as typeof tagsMode)}>
              <option value="none">{t('taskDefaults.noDefault')}</option>
              <option value="above">{t('taskDefaults.fromAbove')}</option>
              <option value="fixed">{t('taskDefaults.specificTags')}</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.dueDate')}
            <select className={selectClass} value={dueMode} onChange={event => setDueMode(event.target.value as typeof dueMode)}>
              <option value="none">{t('taskDefaults.noDefault')}</option>
              <option value="today">{t('taskDefaults.todayPlus')}</option>
              <option value="above">{t('taskDefaults.fromAbove')}</option>
            </select>
          </label>
        </div>
        {assigneeMode === 'fixed' ? <label className="grid gap-1 text-xs text-muted">{t('taskDefaults.person')}
          <select className={selectClass} value={assigneeId} onChange={event => setAssigneeId(event.target.value)}>
            <option value="">{t('taskDefaults.choose')}</option>
            {members.filter(member => !member.pending).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}
          </select>
        </label> : null}
        {tagsMode === 'fixed' ? <fieldset className="flex flex-wrap gap-3 text-sm"><legend className="sr-only">{t('taskDefaults.specificTags')}</legend>
          {tags.length === 0 ? <span className="text-xs text-muted">{t('taskDefaults.noTags')}</span> : tags.map(tag => <label key={tag.id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={tagIds.includes(tag.id)} onChange={event => setTagIds(current => event.target.checked ? [...current, tag.id] : current.filter(id => id !== tag.id))} />{tag.name}
          </label>)}
        </fieldset> : null}
        {dueMode === 'today' ? <label className="grid max-w-48 gap-1 text-xs text-muted">{t('taskDefaults.daysAfterToday')}
          <TextInput inputMode="numeric" value={dueOffset} onChange={event => setDueOffset(event.target.value)} />
        </label> : null}
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={priorityAbove} onChange={event => setPriorityAbove(event.target.checked)} />{t('taskDefaults.priorityFromAbove')}</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={estimateAbove} onChange={event => setEstimateAbove(event.target.checked)} />{t('taskDefaults.estimateFromAbove')}</label>
        </div>
      </section>
      <section className="space-y-3" aria-label={t('taskDefaults.fields')}>
        <h3 className="text-sm font-medium text-ink">{t('taskDefaults.fields')}</h3>
        <p className="text-xs text-muted">{t('taskDefaults.fieldsHelp')}</p>
        {fields.length === 0 ? <p className="text-sm text-muted">{t('taskDefaults.noFields')}</p> : fields.map(field => {
          const draft = drafts[field.id] ?? clearedFieldDraft(field);
          const source = sources[field.id] ?? 'fixed';
          return <div key={field.id} className="rounded-lg border border-line p-3">
            <label className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">{t('taskDefaults.valueSource', { name: field.name })}
              <select className={selectClass} value={source} onChange={event => setSources(current => ({ ...current, [field.id]: event.target.value as Source }))}>
                <option value="fixed">{t('taskDefaults.fixedValue')}</option>
                <option value="above">{t('taskDefaults.fromAbove')}</option>
                {field.type === 'date' ? <option value="today">{t('taskDefaults.todayPlus')}</option> : null}
              </select>
            </label>
            {source === 'fixed' ? <>
              <FieldInput field={field} draft={draft} members={members} onChange={next => setDrafts(current => ({ ...current, [field.id]: next }))} />
              {isClearedDraft(draft) ? <p className="mt-1 text-xs text-muted">{t('taskDefaults.fieldEmpty')}</p> : null}
            </> : source === 'above' ? <p className="text-xs text-muted">{t('taskDefaults.fieldFromAbove')}</p>
              : <label className="grid max-w-48 gap-1 text-xs text-muted">{t('taskDefaults.daysAfterToday')}
                <TextInput inputMode="numeric" value={offsets[field.id] ?? '0'} onChange={event => setOffsets(current => ({ ...current, [field.id]: event.target.value }))} />
              </label>}
          </div>;
        })}
      </section>
      <p className="text-xs text-muted">{t('taskDefaults.footnote')}</p>
      {problem ? <p role="alert" className="text-sm text-danger">{problem}</p> : null}
      <SaveFeedback error={save.error} uncertainError={save.uncertain?.error ?? null} subject="fieldValueSave" />
    </fieldset>
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={holding} onClick={onClose}>{t('taskDefaults.cancel')}</Button>
      {save.uncertain ? <Button type="button" onClick={() => save.retryUncertain()}>{t('taskDefaults.retrySame')}</Button> : null}
      <Button type="submit" variant="primary" disabled={save.pendingCommand !== null}>{save.pendingCommand !== null ? t('taskDefaults.saving') : t('taskDefaults.save')}</Button>
    </div>
  </form>;
}
