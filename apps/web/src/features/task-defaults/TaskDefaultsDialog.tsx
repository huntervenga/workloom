import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { MembershipDto, TaskDefaultsDto, TaskFieldDefinitionDto, TaskPriority, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { FieldInput } from '../fields/FieldInput';
import { clearedFieldDraft, draftFromFieldValue, isClearedDraft, parseFieldDraft, type FieldDraft } from '../fields/valueDraft';
import { useTaskFieldsQuery } from '../fields';
import { useMembershipsQuery } from '../workspace/queries';
import { useStatusesQuery } from '../projects/queries';
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
  const ready = defaults.isSuccess && fields.isSuccess && statuses.isSuccess;
  return <DialogShell open variant="wide" onOpenChange={next => { if (!next) onClose(); }} title={t('taskDefaults.title')} description={t('taskDefaults.description')}>
    {ready ? <Form key={defaults.data.revision} saved={defaults.data} fields={fields.data.filter(field => field.archivedAt === null && !field.locked)} statuses={statuses.data} members={members.data ?? []}
        actorId={actorId} workspaceId={workspaceId} projectId={projectId} onClose={onClose} />
      : defaults.isError || fields.isError || statuses.isError ? <p role="alert" className="text-sm text-danger">{t('taskDefaults.loadFailed')}</p>
      : <p role="status" className="text-sm text-muted">{t('taskDefaults.loading')}</p>}
  </DialogShell>;
}

function Form({ saved, fields, statuses, members, actorId, workspaceId, projectId, onClose }: {
  saved: TaskDefaultsDto; fields: readonly TaskFieldDefinitionDto[]; statuses: readonly TaskStatusDto[]; members: readonly MembershipDto[];
  actorId: string; workspaceId: string; projectId: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveTaskDefaults(actorId, workspaceId, projectId);
  const config = saved.config;
  const [statusId, setStatusId] = useState(config.statusId ?? '');
  const [priority, setPriority] = useState<string>(config.priority ?? '');
  const [estimate, setEstimate] = useState(config.estimateMinutes === null ? '' : formatEstimate(config.estimateMinutes));
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() => Object.fromEntries(fields.map(field => {
    const stored = config.fieldValues.find(item => item.fieldId.toLowerCase() === field.id.toLowerCase());
    return [field.id, stored ? draftFromFieldValue(field, stored.value) : clearedFieldDraft(field)];
  })));
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    const parsedEstimate = estimate.trim() === '' ? { valid: true as const, minutes: null } : parseEstimateInput(estimate);
    if (!parsedEstimate.valid) { setProblem(parsedEstimate.message); return; }
    const fieldValues: TaskDefaultsDto['config']['fieldValues'] = [];
    for (const field of fields) {
      const draft = drafts[field.id];
      if (!draft || isClearedDraft(draft)) continue;
      const parsed = parseFieldDraft(field, draft);
      if (!parsed.ok) { setProblem(`${field.name}: ${parsed.message}`); return; }
      if (parsed.value.value === null) continue;
      fieldValues.push({ fieldId: field.id, value: parsed.value });
    }
    setProblem(null);
    save.mutate({ input: { expectedRevision: saved.revision, config: { statusId: statusId || null, priority: (priority || null) as TaskPriority | null, estimateMinutes: parsedEstimate.minutes, fieldValues } } }, { onSuccess: onClose });
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
      <section className="space-y-3" aria-label={t('taskDefaults.fields')}>
        <h3 className="text-sm font-medium text-ink">{t('taskDefaults.fields')}</h3>
        <p className="text-xs text-muted">{t('taskDefaults.fieldsHelp')}</p>
        {fields.length === 0 ? <p className="text-sm text-muted">{t('taskDefaults.noFields')}</p> : fields.map(field => {
          const draft = drafts[field.id] ?? clearedFieldDraft(field);
          return <div key={field.id} className="rounded-lg border border-line p-3">
            <FieldInput field={field} draft={draft} members={members} onChange={next => setDrafts(current => ({ ...current, [field.id]: next }))} />
            {isClearedDraft(draft) ? <p className="mt-1 text-xs text-muted">{t('taskDefaults.fieldEmpty')}</p> : null}
          </div>;
        })}
      </section>
      <p className="text-xs text-muted">{t('taskDefaults.footnote')}</p>
      {problem ? <p role="alert" className="text-sm text-danger">{problem}</p> : null}
      <SaveFeedback error={save.error} uncertainError={save.uncertain?.error ?? null} subject="fieldValueSave" />
    </fieldset>
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" onClick={onClose}>{t('taskDefaults.cancel')}</Button>
      {save.uncertain ? <Button type="button" onClick={() => save.retryUncertain({ onSuccess: onClose })}>{t('taskDefaults.retrySame')}</Button> : null}
      <Button type="submit" variant="primary" disabled={save.pendingCommand !== null}>{save.pendingCommand !== null ? t('taskDefaults.saving') : t('taskDefaults.save')}</Button>
    </div>
  </form>;
}
