import { useTranslation , type TranslationKey } from '../../i18n';
import type { CategorizedWorkLogDto, ProjectWorkCategoryBindingDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { CategoryBadge } from './CategoryBadge';
import type { WorkCategoryCommands } from './queries';

export interface RecategorizeSession {
  key: string;
  log: CategorizedWorkLogDto;
  binding: ProjectWorkCategoryBindingDto;
  taskTitle: string;
  memberName: string;
  optionId: string;
  reason: string;
  stale: boolean;
}
export function recategorizeSession(log: CategorizedWorkLogDto, binding: ProjectWorkCategoryBindingDto, taskTitle: string, memberName: string): RecategorizeSession {
  return { key: log.id, log, binding, taskTitle, memberName, optionId: log.category.kind === 'categorized' && log.category.fieldId === binding.fieldId ? log.category.optionId : '', reason: '', stale: false };
}
interface Props {
  session: RecategorizeSession | null;
  open: boolean;
  field: TaskFieldDefinitionDto | null;
  writable: boolean;
  mutation: WorkCategoryCommands['recategorize'];
  onChange: (session: RecategorizeSession) => void;
  onClose: () => void;
  onSaved: (key: string) => void;
  onReload: (session: RecategorizeSession) => Promise<{ log: CategorizedWorkLogDto; binding: ProjectWorkCategoryBindingDto }>;
}

export function RecategorizeDialog(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [validation, setValidation] = useState<TranslationKey | null>(null);
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const { session, mutation } = props;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  if (!session) return null;
  const heldHere = held?.workLogId === session.log.id ? held : null;
  const blocked = held !== null && heldHere === null;
  const shownOption = heldHere ? heldHere.input.optionId ?? '' : session.optionId;
  const shownReason = heldHere?.input.reason ?? session.reason;
  const available = props.field?.id === session.binding.fieldId && props.field.archivedAt === null && props.field.type === 'single_select';
  const options = available ? props.field?.options.filter((option) => option.archivedAt === null) ?? [] : [];
  const ownError = mutation.variables?.workLogId === session.log.id ? mutation.error : null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.writable || mutation.pendingCommand || blocked) return;
    if (heldHere && mutation.uncertain) { mutation.retryUncertain({ onSuccess: () => props.onSaved(session.key) }); return; }
    if (session.stale || session.log.state !== 'active') return;
    const previous = session.log.category;
    const unchanged = shownOption ? previous.kind === 'categorized' && previous.fieldId === session.binding.fieldId && previous.optionId === shownOption : previous.kind === 'uncategorized';
    if (unchanged) { setNotice('work-categories.theCategoryHasNotChangedTheEntryIsUnchanged'); return; }
    if (!session.reason.trim()) { setValidation('work-categories.giveAReasonForChangingTheWorkType'); return; }
    if (shownOption && !options.some((option) => option.id === shownOption)) { setValidation('work-categories.chooseAnActiveOptionFromTheCurrentFieldOr'); return; }
    setValidation(null); setNotice(null);
    mutation.mutate({ workLogId: session.log.id, periodId: session.log.periodId, input: { expectedWorkLogRevision: session.log.revision, expectedBindingRevision: session.binding.revision, optionId: shownOption || null, reason: session.reason.trim() } }, { onSuccess: () => props.onSaved(session.key), onError: (failure) => { if (failure instanceof ApiError && failure.kind === 'conflict') props.onChange({ ...session, stale: true }); } });
  };
  const reload = async () => {
    if (held || reloading) return;
    setReloading(true); setNotice(null);
    try { const fresh = await props.onReload(session); props.onChange({ ...session, log: fresh.log, binding: fresh.binding, stale: false }); mutation.reset(); setNotice('work-categories.currentEntryLoadedYourSelectionAndReasonArePreserved'); }
    catch { setNotice('work-categories.couldNotRefreshTheEntryYourInputIsPreserved'); }
    finally { setReloading(false); }
  };
  return <DialogShell title={t('work-categories.changeRecordedWorkType')} description={t('work-categories.changesTheCategoryOfThisEntryAndPreservesIts', { taskTitle: session.taskTitle, person: session.memberName, entryType: session.log.sourceKind==='manual_period'?t('work-categories.weekly'):t('work-categories.attendance') })} open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    <form className="mt-5 space-y-4" onSubmit={submit}>
      <div className="space-y-1"><p className="text-xs text-muted">{t('work-categories.savedWorkTypeForThisEntry')}</p><CategoryBadge category={session.log.category} /></div>
      {session.log.state === 'void' ? <p className="text-sm text-muted">{t('work-categories.thisEntryIsVoidedRestoreItExplicitlyByEditing')}</p> : null}
      {blocked ? <p role="status" className="text-sm text-amber-800">{t('work-categories.anotherCategoryChangeIsUnresolvedResolveThatSaveFirst')}</p> : null}
      <fieldset disabled={!props.writable || held !== null || session.log.state !== 'active'} className="min-w-0 space-y-4">
        <div className="space-y-1.5"><label htmlFor={`${id}-option`} className="text-sm font-medium">{t('work-categories.newWorkType')}</label><select id={`${id}-option`} className={inputClassName()} value={shownOption} onChange={(event) => { props.onChange({ ...session, optionId: event.target.value }); setValidation(null); setNotice(null); }}><option value="">{t('work-categories.uncategorized')}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}{shownOption && !options.some((option) => option.id === shownOption) ? <option value={shownOption} disabled>{t('work-categories.unavailableForNewSelection2', { option: session.log.category.kind === 'categorized' ? session.log.category.optionLabel : t('work-categories.savedOption') })}</option> : null}</select>{!available ? <p className="text-xs text-muted">{t('work-categories.noActiveWorkTypeFieldSelectedYouCanExplicitly')}</p> : null}</div>
        <div className="space-y-1.5"><label htmlFor={`${id}-reason`} className="text-sm font-medium">{t('work-categories.reasonForChangingWorkType')}</label><TextInput id={`${id}-reason`} value={shownReason} onChange={(event) => props.onChange({ ...session, reason: event.target.value })} maxLength={1000} /></div>
      </fieldset>
      {validation ? <p role="alert" className="text-sm text-red-700">{t(validation)}</p> : null}
      <SaveFeedback subject="recategorize" error={ownError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={session.stale ? <Button size="sm" disabled={reloading} onClick={() => void reload()}>{t('work-categories.reloadCurrentEntryAndSettings')}</Button> : null} />
      {notice ? <p role="status" className="text-sm text-muted">{t(notice)}</p> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={props.onClose}>{t('work-categories.close')}</Button>{props.writable ? <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || blocked || session.stale || session.log.state !== 'active'}>{heldHere ? mutation.pendingCommand ? t('work-categories.saving') : t('work-categories.retryOriginalSave') : t('work-categories.saveNewWorkType')}</Button> : null}</div>
    </form>
  </DialogShell>;
}
