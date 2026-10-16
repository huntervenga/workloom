import { useTranslation , type TranslationKey } from '../../i18n';
import { Button, inputClassName } from '@workloom/ui';
import { Settings2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useTaskFieldsQuery } from '../fields';
import { useWorkCategoryBindingQuery, useWorkCategoryCommands } from './queries';

interface Props { actorId: string; workspaceId: string; projectId: string; canManage: boolean }
interface Draft { fieldId: string; revision: number }

/** This component outlives the dialog, including its protected binding mutation and unsent draft. */
export function WorkCategorySettings({ actorId, workspaceId, projectId, canManage }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const binding = useWorkCategoryBindingQuery(actorId, workspaceId, projectId);
  const fields = useTaskFieldsQuery(actorId, workspaceId, projectId);
  const mutation = useWorkCategoryCommands(actorId, workspaceId, projectId).binding;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const error = isAccessDenied(binding.error) ? binding.error : isAccessDenied(fields.error) ? fields.error : isAccessDenied(mutation.error) ? mutation.error : binding.error ?? fields.error;
  const denied = isAccessDenied(error);
  const activeFields = fields.data?.filter((field) => field.archivedAt === null && field.type === 'single_select') ?? [];
  const shownFieldId = held ? held.input.fieldId ?? '' : draft?.fieldId ?? binding.data?.fieldId ?? '';
  const selectedField = fields.data?.find((field) => field.id === shownFieldId);
  const revision = draft?.revision ?? binding.data?.revision ?? 1;
  const reload = async () => {
    if (held || reloading) return;
    setReloading(true); setNotice(null);
    const [freshBinding, freshFields] = await Promise.all([binding.refetch(), fields.refetch()]);
    setReloading(false);
    if (freshBinding.isError || freshFields.isError || !freshBinding.data) { setNotice('work-categories.couldNotLoadCurrentSettingsYourSelectedFieldIs'); return; }
    setDraft({ fieldId: shownFieldId, revision: freshBinding.data.revision });
    mutation.reset(); setStale(false); setNotice('work-categories.currentSettingsLoadedReviewTheSelectedFieldThenSave');
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || mutation.pendingCommand || denied) return;
    const saved = () => { setDraft(null); setStale(false); setOpen(false); setNotice('work-categories.workTypeFieldSaved'); };
    if (mutation.uncertain) { mutation.retryUncertain({ onSuccess: saved }); return; }
    if (stale || !binding.data) return;
    if (shownFieldId && !activeFields.some((field) => field.id === shownFieldId)) { setNotice('work-categories.chooseAnActiveSingleSelectFieldOrRemoveThe'); return; }
    mutation.mutate({ input: { expectedRevision: revision, fieldId: shownFieldId || null } }, { onSuccess: saved, onError: (failure) => { if (failure instanceof ApiError && failure.kind === 'conflict') setStale(true); } });
  };
  return <>
    {canManage ? <Button onClick={() => setOpen(true)}><Settings2 size={16} aria-hidden="true" />{t('work-categories.workTypes')}</Button> : null}
    {held ? <div className="text-xs text-amber-800"><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{t('work-categories.openOriginalWorkTypeSave')}</Button></div> : null}
    <DialogShell title={t('work-categories.projectWorkType')} description={t('work-categories.chooseAnExistingSingleSelectFieldItsValueWill')} open={open} onOpenChange={setOpen}>
      {error ? <div className="mt-5"><QueryErrorState error={error} subject="workCategory" headingLevel={3} retrying={binding.isFetching || fields.isFetching} onRetry={() => { mutation.reset(); void binding.refetch(); void fields.refetch(); }} /></div> : binding.isPending || fields.isPending ? <p role="status" className="mt-5 text-sm text-muted">{t('work-categories.loadingFieldsAndSettings')}</p> : <form className="mt-5 space-y-4" onSubmit={submit}>
        {binding.data?.availability === 'field_archived' ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('work-categories.theSelectedFieldIsArchivedNewHoursWillBe')}</p> : null}
        <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium">{t('work-categories.workTypeField')}</label><select id={id} className={inputClassName()} value={shownFieldId} disabled={!canManage || held !== null} onChange={(event) => { setDraft({ fieldId: event.target.value, revision }); setNotice(null); }}><option value="">{t('work-categories.doNotUseAField')}</option>{activeFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}{shownFieldId && !activeFields.some((field) => field.id === shownFieldId) ? <option value={shownFieldId} disabled>{t('work-categories.unavailable2', { name: selectedField?.name ?? t('work-categories.previouslySelectedField') })}</option> : null}</select></div>
        {activeFields.length === 0 ? <p className="text-sm text-muted">{t('work-categories.createASingleSelectFieldInTheProjectColumns')}</p> : null}
        <p className="text-xs leading-relaxed text-muted">{t('work-categories.categoriesUseOptionsFromTheSelectedFieldHidingA')}</p>
        <SaveFeedback subject="workCategorySave" error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} action={stale ? <Button size="sm" disabled={reloading} onClick={() => void reload()}>{t('work-categories.reloadCurrentSettings')}</Button> : null} />
        {notice ? <p role="status" className="text-sm text-muted">{t(notice)}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={() => setOpen(false)}>{t('work-categories.close')}</Button><Button type="submit" variant="primary" disabled={!canManage || mutation.pendingCommand !== null || stale}>{mutation.pendingCommand ? t('work-categories.saving') : mutation.uncertain ? t('work-categories.retryOriginalSave') : t('work-categories.saveWorkTypeField')}</Button></div>
      </form>}
    </DialogShell>
  </>;
}
