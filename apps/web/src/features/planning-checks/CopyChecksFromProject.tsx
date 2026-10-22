import { useState } from 'react';
import { Button } from '@workloom/ui';
import type { PlanningCheckRuleDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { describeError } from '../../lib/errors';
import { fetchTaskFields } from '../fields/api';
import { fetchSections } from '../projects/api';
import { useProjectsQuery } from '../projects/queries';
import { fetchPlanningCheckSettings } from './api';
import { copyPlanningChecks } from './copyChecks';

interface CopyProps {
  actorId: string; workspaceId: string; projectId: string; existing: readonly PlanningCheckRuleDto[];
  targetFields: readonly TaskFieldDefinitionDto[]; targetSections: readonly SectionDto[]; disabled: boolean;
  onCopy: (rules: PlanningCheckRuleDto[]) => void;
}
interface Bundle { projectName: string; rules: PlanningCheckRuleDto[]; fields: TaskFieldDefinitionDto[]; sections: SectionDto[] }

export function CopyChecksFromProject(props: CopyProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Projects are only requested once the person asks to copy.
  if (!open) return <Button size="sm" variant="ghost" disabled={props.disabled} onClick={() => setOpen(true)}>{t('planningChecks.copyOpen')}</Button>;
  return <CopyChecksPanel {...props} onDone={() => setOpen(false)} />;
}

/** Brings another project's checks into the unsaved draft, matched by field and section names; nothing is saved here. */
function CopyChecksPanel({ actorId, workspaceId, projectId, existing, targetFields, targetSections, disabled, onCopy, onDone }: CopyProps & { onDone: () => void }) {
  const { t } = useTranslation();
  const projects = useProjectsQuery(actorId, workspaceId);
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [ids] = useState(() => new Map<number, string>());
  const choosable = (projects.data?.projects ?? []).filter(project => project.id !== projectId && project.archivedAt === null);
  const source = choosable.find(project => project.id === sourceId);
  // Stable ids between previews, so the rules the person reviewed are the rules that get added.
  const newId = (() => { let index = 0; return () => { const key = index++; const known = ids.get(key); if (known) return known; const fresh = crypto.randomUUID(); ids.set(key, fresh); return fresh; }; })();
  const preview = bundle ? copyPlanningChecks({ rules: bundle.rules, sourceFields: bundle.fields, targetFields, sourceSections: bundle.sections, targetSections, existing, newId, fieldChoices: choices }) : null;

  async function review() {
    if (!source || busy) return;
    setBusy(true); setError(null); setBundle(null); setChoices({});
    try {
      const [settings, fields, sections] = await Promise.all([fetchPlanningCheckSettings(workspaceId, source.id), fetchTaskFields(workspaceId, source.id), fetchSections(workspaceId, source.id)]);
      setBundle({ projectName: source.name, rules: settings.config.rules, fields, sections });
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  }

  return <section aria-label={t('planningChecks.copyTitle')} className="space-y-3 rounded-lg border border-line p-3">
    <h3 className="text-sm font-medium text-ink">{t('planningChecks.copyTitle')}</h3>
    <p className="text-xs text-muted">{t('planningChecks.copyHelp')}</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid min-w-0 flex-1 gap-1 text-xs text-muted">{t('planningChecks.copySource')}
        <select className="h-9 min-w-0 rounded-md border border-line bg-surface px-2 text-sm text-ink" value={sourceId} disabled={disabled || busy || !projects.isSuccess} onChange={event => { setSourceId(event.target.value); setBundle(null); }}>
          <option value="">{t('planningChecks.copyChoose')}</option>
          {choosable.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={disabled || busy || !source} onClick={() => void review()}>{busy ? t('planningChecks.copying') : t('planningChecks.copyReview')}</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>{t('planningChecks.copyCancel')}</Button>
    </div>
    {projects.isSuccess && choosable.length === 0 ? <p role="status" className="text-xs text-muted">{t('planningChecks.copyNoProjects')}</p> : null}
    {error ? <p role="alert" className="text-xs text-danger">{describeError(error, 'timeOffSave').description}</p> : null}
    {bundle && preview ? <div className="space-y-3" role="group" aria-label={t('planningChecks.copyPreview', { project: bundle.projectName })}>
      {bundle.rules.length === 0 ? <p role="status" className="text-xs text-muted">{t('planningChecks.copyNothing', { project: bundle.projectName })}</p> : null}
      {preview.unmatchedFields.map(item => <label key={item.id} className="grid gap-1 text-xs text-muted">{t('planningChecks.copyFieldChoice', { field: item.name })}
        <select className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink" value={choices[item.id] ?? ''} onChange={event => setChoices(current => ({ ...current, [item.id]: event.target.value }))}>
          <option value="">{t('planningChecks.copyFieldSkip')}</option>
          {targetFields.filter(field => field.archivedAt === null && field.type === item.type).map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
        </select>
      </label>)}
      {preview.rules.length > 0 ? <div className="space-y-1"><p className="text-xs font-medium text-ink">{t('planningChecks.copyWillAdd', { count: preview.rules.length })}</p><ul className="list-disc pl-4 text-xs text-ink-soft">{preview.rules.map(rule => <li key={rule.id}>{rule.name}</li>)}</ul></div> : null}
      {preview.skipped.length > 0 ? <ul className="list-disc pl-4 text-xs text-muted">{preview.skipped.map((item, index) => <li key={`${item.name}-${index}`}>{item.reason === 'duplicate' ? t('planningChecks.copySkipDuplicate', { name: item.name }) : item.reason === 'section' ? t('planningChecks.copySkipSection', { name: item.name }) : t('planningChecks.copySkipField', { name: item.name })}</li>)}</ul> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={preview.rules.length === 0} onClick={() => { onCopy(preview.rules); onDone(); }}>{t('planningChecks.copyAdd', { count: preview.rules.length })}</Button>
        <span className="text-xs text-muted">{t('planningChecks.copySaveHint')}</span>
      </div>
    </div> : null}
  </section>;
}
