import { t, useTranslation } from '../../i18n';
import type { MembershipDto, PlanningPeriodDto, RecurrenceExceptionKind, SectionDto, TaskStatusDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useState, type ReactNode } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { fetchRecurrenceInstances, fetchRecurrenceSeriesDetail } from './api';
import { RecurrenceEditPreview, RecurrenceExceptionPreview, RecurrencePeriodsPreview } from './RecurrenceChangePreview';
import { recurrencePeriodName } from './RecurrencePreview';
import { RecurrenceRuleFields, type RecurrenceRuleDraft } from './RecurrenceRuleFields';
import { RecurrenceTemplateFields, type RecurrenceTemplateDraft } from './RecurrenceTemplateFields';
import {
  recurrenceEditVariables, recurrenceExceptionVariables, recurrencePeriodVariables, recurrencePreviewErrorCopy,
  type RecurrenceEditSession, type RecurrenceExceptionSession, type RecurrencePeriodSession, type RecurrencePreviewCheck,
} from './useRecurrenceManagement';
import type { RecurrenceWorkspace } from './useRecurrenceWorkspace';

export interface RecurrenceManagementDialogProps {
  controller: RecurrenceWorkspace;
  workspaceId: string;
  periods: readonly PlanningPeriodDto[];
  members: readonly MembershipDto[];
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  writable: boolean;
  accessDenied: boolean;
}

const bodyClass = 'min-h-0 flex-1 space-y-5 overflow-y-auto scroll-py-4 py-5';
const footerClass = 'flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface pt-4';
const hintClass = 'text-xs leading-relaxed text-muted';
function failure(error: unknown): Error { return error instanceof Error ? error : new Error('Read failed'); }
function same(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

function useReload() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = async (load: () => Promise<boolean>) => {
    setLoading(true); setError(null);
    try { if (!await load()) setError(new ApiError({ kind: 'conflict', status: 409 })); }
    catch (error) { setError(failure(error)); }
    finally { setLoading(false); }
  };
  return { loading, error, run };
}

interface FrameProps {
  title: string;
  children: ReactNode;
  denied: boolean;
  blocked: boolean;
  heldHere: boolean;
  pending: boolean;
  uncertain: Error | null;
  error: Error | null;
  check: RecurrencePreviewCheck | null;
  reload: ReturnType<typeof useReload>;
  ready: boolean;
  writable: boolean;
  onClose: () => void;
  onDiscard: () => void;
  onCheck: () => void;
  onApply: () => void;
  onRetry: () => void;
  onReload: () => Promise<void>;
}
function Frame(p: FrameProps) {
  const { t } = useTranslation();
  const locked = p.blocked || p.heldHere || !p.writable || p.reload.loading;
  return <DialogShell variant="drawer" title={p.title} description={t('recurrence.reviewTheEffectsBeforeApplyingClosingThisDialogPreserves')} open onOpenChange={open => { if (!open) p.onClose(); }}>
    <div className={bodyClass}>
      {p.denied ? <p role="status" className="text-sm text-muted">{t('recurrence.seriesOrMeetingDataIsUnavailableFieldsAndSchedule')}</p> : <>
        {p.children}
        {p.check?.problems.length ? <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-red-800">{p.check.problems.map(text => <li key={text}>{text}</li>)}</ul> : null}
        {p.check?.error ? <p role="alert" className="text-sm text-red-800">{recurrencePreviewErrorCopy(p.check.error)}</p> : null}
        {p.check?.pending ? <p role="status" className="text-sm text-muted">{t('recurrence.checkingChange')}</p> : null}
        <SaveFeedback subject="taskSave" error={p.error ?? p.reload.error} uncertainError={p.uncertain} />
      </>}
      {p.pending ? <p role="status" className="text-sm text-muted">{t('recurrence.waitingForResponseSubmittedValuesAreLocked')}</p> : null}
      {p.uncertain ? <p role="status" className="text-sm text-amber-900">{t('recurrence.resultUnknownRetryTheOriginalRequestUnchanged')}</p> : null}
      {p.blocked ? <p role="status" className="text-sm text-amber-900">{t('recurrence.anotherRequestForThisActionIsUnresolvedOpenIt')}</p> : null}
    </div>
    <div className={footerClass}>
      <Button variant="ghost" disabled={p.heldHere} onClick={p.onDiscard}>{t('recurrence.discardThisDraft')}</Button>
      <Button onClick={p.onClose}>{t('recurrence.close')}</Button>
      {!p.denied && !p.heldHere ? <>
        <Button disabled={locked || p.check?.pending} onClick={() => void p.onReload()}>{p.reload.loading ? t('recurrence.refreshing') : t('recurrence.reloadCurrentDataAndKeepMyInput')}</Button>
        <Button disabled={locked || p.check?.pending} onClick={p.onCheck}>{t('recurrence.previewChange')}</Button>
        <Button variant="primary" disabled={locked || !p.ready || p.check?.pending} onClick={p.onApply}>{t('recurrence.applyChange')}</Button>
      </> : null}
      {p.uncertain ? <Button variant="primary" disabled={p.pending} onClick={p.onRetry}>{t('recurrence.retryOriginalChange')}</Button> : null}
    </div>
  </DialogShell>;
}

export function RecurrenceManagementDialog(props: RecurrenceManagementDialogProps) {
  const active = props.controller.management.active;
  if (active === null) return null;
  switch (active.kind) {
    case 'edit': return <EditDialog key={active.session.id} {...props} session={active.session} />;
    case 'periods': return <PeriodsDialog key={active.session.id} {...props} session={active.session} />;
    case 'exception': return <ExceptionDialog key={active.session.id} {...props} session={active.session} />;
  }
}

function EditDialog(p: RecurrenceManagementDialogProps & { session: RecurrenceEditSession }) {
  const { t } = useTranslation();
  const { controller: c, session: s } = p;
  const m = c.management;
  const mutation = c.commands.edit;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const own = held?.draftId === s.id && same(held.seriesId, s.base.id) ? held : null;
  const error = mutation.variables?.draftId === s.id && held === null ? mutation.error : null;
  const reload = useReload();
  const denied = p.accessDenied || [s.check?.error, error, reload.error].some(isAccessDenied);
  const locked = held !== null || !p.writable || reload.loading;
  const schedule = own?.input.schedule;
  const rule: RecurrenceRuleDraft = schedule ? {
    frequency: schedule.frequency, weekdays: [...(schedule.weekdays ?? [])], startDate: schedule.startDate, localTime: schedule.localTime,
    timezone: schedule.timezone, durationMinutes: String(schedule.plannedDurationMinutes), endKind: schedule.end.kind,
    endDate: schedule.end.kind === 'on_date' ? schedule.end.endDate : '', count: schedule.end.kind === 'after_count' ? String(schedule.end.count) : '', targetPeriodIds: [...s.base.boundPeriodIds],
  } : s.rule;
  const sentTemplate = own?.input.template;
  const template: RecurrenceTemplateDraft = sentTemplate ? {
    title: sentTemplate.title, statusId: sentTemplate.statusId, sectionId: sentTemplate.sectionId ?? '', organizerMembershipId: sentTemplate.organizerMembershipId,
    attendeeMembershipIds: [...sentTemplate.attendeeMembershipIds], joinUrl: sentTemplate.joinUrl ?? '',
  } : s.template;
  const variables = recurrenceEditVariables(s);
  const check = () => { mutation.reset(); m.checkEdit(s.id); };
  return <Frame title={t('recurrence.changeSeriesFromADate')} denied={denied} blocked={held !== null && own === null} heldHere={own !== null} pending={own !== null && mutation.pendingCommand !== null} uncertain={own ? mutation.uncertain?.error ?? null : null} error={error} check={s.check} reload={reload} ready={variables !== null} writable={p.writable} onClose={m.close} onDiscard={() => m.discard('edit', s.id, own !== null)} onCheck={check} onApply={() => { if (variables) mutation.mutate(variables, { onError: e => { if (e instanceof ApiError && e.kind === 'conflict') m.clearPreview('edit', s.id); } }); }} onRetry={() => mutation.retryUncertain()} onReload={() => reload.run(async () => m.rebaseEdit(s.id, await fetchRecurrenceSeriesDetail(p.workspaceId, s.base.id), own !== null))}>
    <label className="block space-y-1.5 text-sm font-medium">{t('recurrence.changeSeriesFromADate')}<TextInput type="date" min="2000-01-01" max="2100-12-31" value={own?.input.effectiveFromNominalDate ?? s.effectiveFromNominalDate} disabled={locked} onChange={e => m.changeEdit(s.id, { effectiveFromNominalDate: e.target.value })} /></label>
    <p className={hintClass}>{t('recurrence.changesStartOnTheSelectedSeriesDateAttendanceCompleted')}</p>
    {s.base.currentVersion.schedule.end.kind === 'after_count' ? <p className={hintClass}>{t('recurrence.seriesDatesAndTotalMeetingCountArePreservedFuture')}</p> : null}
    <RecurrenceRuleFields value={rule} onChange={rule => m.changeEdit(s.id, { rule })} periods={p.periods} disabled={locked} showPeriods={false} editMode immutableCadence={s.base.currentVersion.schedule.end.kind === 'after_count'} />
    <RecurrenceTemplateFields value={template} onChange={template => m.changeEdit(s.id, { template })} members={p.members} statuses={p.statuses} sections={p.sections} disabled={locked} />
    {s.preview && (!own || own.input.previewHash === s.preview.previewHash) ? <RecurrenceEditPreview preview={s.preview} periods={p.periods} /> : null}
  </Frame>;
}

function PeriodsDialog(p: RecurrenceManagementDialogProps & { session: RecurrencePeriodSession }) {
  const { t } = useTranslation();
  const { controller: c, session: s } = p;
  const m = c.management;
  const mutation = c.commands.addPeriods;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const own = held?.draftId === s.id && same(held.seriesId, s.base.id) ? held : null;
  const error = mutation.variables?.draftId === s.id && held === null ? mutation.error : null;
  const reload = useReload();
  const denied = p.accessDenied || [s.check?.error, error, reload.error].some(isAccessDenied);
  const locked = held !== null || !p.writable || reload.loading;
  const selected = own?.input.periodIds ?? s.periodIds;
  const variables = recurrencePeriodVariables(s);
  const available = new Set(p.periods.map(period => period.id));
  return <Frame title={t('recurrence.addSeriesPeriods')} denied={denied} blocked={held !== null && own === null} heldHere={own !== null} pending={own !== null && mutation.pendingCommand !== null} uncertain={own ? mutation.uncertain?.error ?? null : null} error={error} check={s.check} reload={reload} ready={variables !== null} writable={p.writable} onClose={m.close} onDiscard={() => m.discard('periods', s.id, own !== null)} onCheck={() => { mutation.reset(); m.checkPeriods(s.id); }} onApply={() => { if (variables) mutation.mutate(variables, { onError: e => { if (e instanceof ApiError && e.kind === 'conflict') m.clearPreview('periods', s.id); } }); }} onRetry={() => mutation.retryUncertain()} onReload={() => reload.run(async () => m.rebasePeriods(s.id, await fetchRecurrenceSeriesDetail(p.workspaceId, s.base.id), own !== null))}>
    <fieldset disabled={locked} className="space-y-3"><legend className="mb-2 text-sm font-semibold">{t('recurrence.seriesPeriods')}</legend>
      <p className={hintClass}>{t('recurrence.existingWeeksStaySelectedChooseAdditionalPeriodsAndPreview')}</p>
      {p.periods.map(period => {
        const bound = s.base.boundPeriodIds.some(id => same(id, period.id));
        return <label key={period.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={bound} checked={bound || selected.includes(period.id)} onChange={e => m.changePeriods(s.id, e.target.checked ? [...selected, period.id] : selected.filter(id => id !== period.id))} /><span>{period.name}{bound ? t('recurrence.alreadySelected') : ''}<span className="block text-xs text-muted">{t('recurrence.endExcluded2', { localStart: period.localStart, localEndExclusive: period.localEndExclusive, timezone: period.timezone })}</span></span></label>;
      })}
      {selected.filter(id => !available.has(id)).map((id, index) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked onChange={() => m.changePeriods(s.id, selected.filter(other => other !== id))} />{t('recurrence.savedPeriodUnavailable')}{index + 1}</label>)}
    </fieldset>
    {s.preview && (!own || own.input.previewHash === s.preview.previewHash) ? <RecurrencePeriodsPreview preview={s.preview} periods={p.periods} /> : null}
  </Frame>;
}

const kindLabels: Record<RecurrenceExceptionKind, string> = {
  get skip() { return t('recurrence.cancelOnlyThisMeeting'); }, get move() { return t('recurrence.moveOnlyThisMeeting'); }, get restore() { return t('recurrence.restoreMeeting'); }, get reset() { return t('recurrence.resetToSeriesRule'); },
};
function ExceptionDialog(p: RecurrenceManagementDialogProps & { session: RecurrenceExceptionSession }) {
  const { t } = useTranslation();
  const { controller: c, session: s } = p;
  const m = c.management;
  const mutation = c.commands.exception;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const own = held?.draftId === s.id && same(held.seriesId, s.baseInstance.seriesId) && held.occurrenceKey === s.baseInstance.occurrenceKey ? held : null;
  const error = mutation.variables?.draftId === s.id && held === null ? mutation.error : null;
  const reload = useReload();
  const denied = p.accessDenied || [s.check?.error, error, reload.error].some(isAccessDenied);
  const locked = held !== null || !p.writable || reload.loading;
  const kind = own?.input.kind ?? s.kind;
  const variables = recurrenceExceptionVariables(s);
  const refresh = () => reload.run(async () => {
    const [series, instances] = await Promise.all([fetchRecurrenceSeriesDetail(p.workspaceId, s.baseSeries.id), fetchRecurrenceInstances(p.workspaceId, s.baseInstance.seriesId, s.baseInstance.plannedPeriodId)]);
    const instance = instances.find(item => same(item.id, s.baseInstance.id));
    return instance !== undefined && m.rebaseException(s.id, series, instance, own !== null);
  });
  return <Frame title={t('recurrence.changeOneMeeting')} denied={denied} blocked={held !== null && own === null} heldHere={own !== null} pending={own !== null && mutation.pendingCommand !== null} uncertain={own ? mutation.uncertain?.error ?? null : null} error={error} check={s.check} reload={reload} ready={variables !== null} writable={p.writable} onClose={m.close} onDiscard={() => m.discard('exception', s.id, own !== null)} onCheck={() => { mutation.reset(); m.checkException(s.id); }} onApply={() => { if (variables) mutation.mutate(variables, { onError: e => { if (e instanceof ApiError && e.kind === 'conflict') m.clearPreview('exception', s.id); } }); }} onRetry={() => mutation.retryUncertain()} onReload={refresh}>
    <p className="text-sm">{t('recurrence.seriesDate2')}<strong>{s.baseInstance.occurrenceKey}</strong> · {recurrencePeriodName(s.baseInstance.plannedPeriodId, p.periods)}</p>
    <fieldset disabled={locked} className="space-y-4">
      <label className="block space-y-1.5 text-sm font-medium">{t('recurrence.meetingAction')}<select className={inputClassName()} value={kind} onChange={e => { const next = e.target.value; if (next === 'skip' || next === 'move' || next === 'restore' || next === 'reset') m.changeException(s.id, { kind: next }); }}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {kind === 'move' ? <><p className={hintClass}>{t('recurrence.newTimeInTheMeetingMustStayWithinIts', { timezone: s.baseSeries.currentVersion.schedule.timezone })}</p><label className="block space-y-1.5 text-sm font-medium">{t('recurrence.newMeetingDate')}<TextInput type="date" min="2000-01-01" max="2100-12-31" value={own?.input.kind === 'move' ? own.input.localDate : s.localDate} onChange={e => m.changeException(s.id, { localDate: e.target.value })} /></label><label className="block space-y-1.5 text-sm font-medium">{t('recurrence.newMeetingTime')}<TextInput type="time" step={60} value={own?.input.kind === 'move' ? own.input.localTime : s.localTime} onChange={e => m.changeException(s.id, { localTime: e.target.value })} /></label></> : null}
      <label className="block space-y-1.5 text-sm font-medium">{t('recurrence.reasonForChange')}<textarea className={inputClassName()} maxLength={1000} rows={3} value={own?.input.reason ?? s.reason} onChange={e => m.changeException(s.id, { reason: e.target.value })} /></label>
    </fieldset>
    <p className={hintClass}>{t('recurrence.thisChangesOnlyOneSeriesDatePersonalPlansAnd')}</p>
    {s.preview && (!own || own.input.previewHash === s.preview.previewHash) ? <RecurrenceExceptionPreview preview={s.preview} members={p.members} /> : null}
  </Frame>;
}
