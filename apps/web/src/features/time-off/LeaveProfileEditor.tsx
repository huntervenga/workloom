import { useEffect, useState } from 'react';
import type { LeaveProfileDto, LeaveSettingsDto, PutLeaveProfileInput } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useTranslation } from '../../i18n';
import { weekdayLabel } from './labels';
import { useProfilePreview } from './queries';
import { LeaveRecalculationReview } from './LeavePreview';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { MICRODAYS, policyForYear } from './presentation';

export function LeaveProfileEditor({ profile, settings, today, disabled, onSave, onDirtyChange, actorId, membershipId }: { profile: LeaveProfileDto | undefined; settings: LeaveSettingsDto; today: string; disabled: boolean; onSave: (input: PutLeaveProfileInput) => void; onDirtyChange?: (dirty: boolean) => void; actorId: string; membershipId: string }) {
  const { t } = useTranslation();
  const [initial, setInitial] = useState<PutLeaveProfileInput>(() => profile ? { expectedRevision: profile.revision, timezone: profile.timezone, employmentStart: profile.employmentStart, employmentEnd: profile.employmentEnd, accountingStart: profile.accountingStart, openingBalances: profile.openingBalances, schedulePeriods: profile.schedulePeriods, reason: '' } : { expectedRevision: 0, timezone: settings.timezone, employmentStart: today, employmentEnd: null, accountingStart: today, openingBalances: [], schedulePeriods: [{ effectiveFrom: today, weeklyMinutes: settings.defaultWeeklyMinutes }], reason: '' });
  const [draft, setDraft] = useState(initial);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  useProtectedDraft(dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const [previewInput, setPreviewInput] = useState<PutLeaveProfileInput | null>(null);
  const preview = useProfilePreview(actorId, settings.workspaceId, membershipId, previewInput);
  const previewCurrent = preview.isSuccess && JSON.stringify(previewInput) === JSON.stringify(draft);
  const changedElsewhere = (profile?.revision ?? 0) !== initial.expectedRevision;
  const loadLatest = () => {
    if (!profile) return;
    const latest: PutLeaveProfileInput = { expectedRevision: profile.revision, timezone: profile.timezone, employmentStart: profile.employmentStart, employmentEnd: profile.employmentEnd, accountingStart: profile.accountingStart, openingBalances: profile.openingBalances, schedulePeriods: profile.schedulePeriods, reason: '' };
    setInitial(latest); setDraft(latest); setPreviewInput(null);
  };
  if (changedElsewhere && !dirty && !disabled) loadLatest();
  const types = policyForYear(settings, Number(today.slice(0, 4)))?.types ?? [];
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (previewCurrent) onSave({ ...draft, expectedSourceVersion: preview.data.sourceVersion }); else setPreviewInput(draft); }}><fieldset disabled={disabled} className="space-y-4">{changedElsewhere ? <div role="status" className="rounded-lg bg-canvas p-3 text-sm"><p>{t('timeOff.changedElsewhere')}</p><Button type="button" size="sm" onClick={loadLatest}>{t('timeOff.loadLatest')}</Button></div> : null}<div className="grid gap-3 sm:grid-cols-2">
    <label className="grid gap-1 text-xs text-muted">{t('timeOff.employmentStart')}<TextInput required type="date" value={draft.employmentStart} onChange={event => setDraft({ ...draft, employmentStart: event.target.value })}/></label>
    <label className="grid gap-1 text-xs text-muted">{t('timeOff.accountingStart')}<TextInput required type="date" value={draft.accountingStart} onChange={event => setDraft({ ...draft, accountingStart: event.target.value })}/></label>
    <label className="grid gap-1 text-xs text-muted">{t('timeOff.employmentEnd')}<TextInput type="date" value={draft.employmentEnd ?? ''} onChange={event => setDraft({ ...draft, employmentEnd: event.target.value || null })}/></label>
    <label className="grid gap-1 text-xs text-muted">{t('timeOff.timezone')}<TextInput required value={draft.timezone} onChange={event => setDraft({ ...draft, timezone: event.target.value })}/></label>
  </div><p className="text-xs text-muted">{t('timeOff.accountingHint')}</p>
  <section className="space-y-2"><h3 className="text-sm font-medium">{t('timeOff.openingBalances')}</h3><div className="grid gap-3 sm:grid-cols-2">{types.filter(type => type.consumesBalance).map(type => <label key={type.id} className="grid gap-1 text-xs text-muted">{type.name}<TextInput type="number" step="0.01" value={(draft.openingBalances.find(balance => balance.typeId === type.id)?.microdays ?? 0) / MICRODAYS} onChange={event => setDraft({ ...draft, openingBalances: [...draft.openingBalances.filter(balance => balance.typeId !== type.id), { typeId: type.id, microdays: Math.round(Number(event.target.value) * MICRODAYS) }] })}/></label>)}</div></section>
  <section className="space-y-3"><h3 className="text-sm font-medium">{t('timeOff.workSchedule')}</h3>{draft.schedulePeriods.map((period, index) => <div key={index} className="space-y-2 rounded-lg border border-line p-3"><div className="flex items-end gap-2"><label className="grid gap-1 text-xs text-muted">{t('timeOff.effectiveFrom')}<TextInput type="date" required value={period.effectiveFrom} onChange={event => setDraft({ ...draft, schedulePeriods: draft.schedulePeriods.map((item, at) => at === index ? { ...item, effectiveFrom: event.target.value } : item) })}/></label><Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, schedulePeriods: draft.schedulePeriods.filter((_, at) => at !== index) })}>{t('timeOff.remove')}</Button></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-7">{period.weeklyMinutes.map((minutes, day) => <label key={day} className="grid gap-1 text-xs text-muted">{weekdayLabel(day)}<TextInput aria-label={t('timeOff.scheduleDayHours', { day: weekdayLabel(day), date: period.effectiveFrom })} type="number" min={0} max={24} step="0.25" value={minutes / 60} onChange={event => { const weeklyMinutes = [...period.weeklyMinutes] as LeaveProfileDto['schedulePeriods'][number]['weeklyMinutes']; weeklyMinutes[day] = Math.round(Number(event.target.value) * 60); setDraft({ ...draft, schedulePeriods: draft.schedulePeriods.map((item, at) => at === index ? { ...item, weeklyMinutes } : item) }); }}/></label>)}</div></div>)}<Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, schedulePeriods: [...draft.schedulePeriods, { effectiveFrom: today, weeklyMinutes: settings.defaultWeeklyMinutes }] })}>{t('timeOff.addSchedule')}</Button></section>
  <label className="grid gap-1 text-xs text-muted">{t('timeOff.correctionReason')}<TextInput value={draft.reason} maxLength={2000} onChange={event => setDraft({ ...draft, reason: event.target.value })}/></label><p className="text-xs text-muted">{t('timeOff.correctionReasonHint')}</p>{preview.isError ? <QueryErrorState error={preview.error} subject="planSave" onRetry={() => void preview.refetch()}/> : previewCurrent ? <LeaveRecalculationReview preview={preview.data} settings={settings}/> : null}<div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" disabled={preview.isFetching}>{t(previewCurrent ? 'timeOff.saveProfile' : 'timeOff.reviewChanges')}</Button><Button type="button" variant="ghost" disabled={!dirty || preview.isFetching} onClick={() => { setDraft(initial); setPreviewInput(null); }}>{t('timeOff.discardChanges')}</Button></div></fieldset></form>;
}
