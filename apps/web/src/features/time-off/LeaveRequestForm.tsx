import { useState } from 'react';
import type { PreviewLeaveRequestInput, BulkLeaveRequestInput, CreateLeaveRequestInput, LeaveOverviewDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useBulkLeavePreview, useLeavePreview } from './queries';
import { LeaveChargeReview, LeaveRecalculationReview } from './LeavePreview';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { futureDate, policyForYear } from './presentation';

export function LeaveRequestForm({ overview, disabled, onCreate, onBulk, actorId, onCancel }: { overview: LeaveOverviewDto; disabled: boolean; onCreate: (input: CreateLeaveRequestInput) => void; onBulk: (input: BulkLeaveRequestInput) => void; actorId: string; onCancel: () => void }) {
  const { t } = useTranslation();
  const [membershipId, setMembershipId] = useState(overview.ownMembershipId);
  const today = overview.members.find(member => member.id === membershipId)?.today ?? overview.today;
  const [startDate, setStartDate] = useState(futureDate(today));
  const [endDate, setEndDate] = useState(futureDate(today));
  const types = overview.settings ? policyForYear(overview.settings, Number(startDate.slice(0, 4)))?.types.filter(type => !type.archived) ?? [] : [];
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [approveNegative, setApproveNegative] = useState(false);
  const [reason, setReason] = useState('');
  const [changed, setChanged] = useState(false);
  const settings = overview.settings;
  const type = types.find(item => item.id === typeId);
  const profileReady = overview.profiles.some(profile => profile.membershipId === membershipId);
  const valid = startDate !== '' && endDate >= startDate && type !== undefined && (bulkMode ? selected.length > 0 : profileReady);
  useProtectedDraft(changed);
  const [previewInput, setPreviewInput] = useState<PreviewLeaveRequestInput | null>(null);
  const [bulkPreviewInput, setBulkPreviewInput] = useState<BulkLeaveRequestInput | null>(null);
  const singleInput: PreviewLeaveRequestInput = { membershipId, typeId, startDate, endDate, note, reason, approveNegative: false };
  const bulkInput: BulkLeaveRequestInput = { membershipIds: selected, typeId, startDate, endDate, note, approveNegative, reason };
  const preview = useLeavePreview(actorId, overview.settings?.workspaceId ?? '', previewInput);
  const bulkPreview = useBulkLeavePreview(actorId, overview.settings?.workspaceId ?? '', bulkPreviewInput);
  const previewCurrent = bulkMode ? bulkPreview.isSuccess && JSON.stringify(bulkInput) === JSON.stringify(bulkPreviewInput) : preview.isSuccess && JSON.stringify(singleInput) === JSON.stringify(previewInput);
  const fetching = preview.isFetching || bulkPreview.isFetching;

  return <form onSubmit={event => { event.preventDefault(); if (!valid) return; if (!previewCurrent) { if (bulkMode) setBulkPreviewInput(bulkInput); else setPreviewInput(singleInput); return; } if (bulkMode) onBulk({ ...bulkInput, expectedSourceVersion: bulkPreview.data?.sourceVersion }); else onCreate({ membershipId, typeId, startDate, endDate, note, reason, expectedSourceVersion: preview.data?.sourceVersion }); }} className="space-y-3">
    <fieldset disabled={disabled || fetching} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">
      {overview.capabilities.canManage ? <label className="grid gap-1 text-xs text-muted">{t('timeOff.person')}<ChoicePicker label={t('timeOff.person')} value={membershipId} searchable options={overview.members.map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl }))} onValueChange={value => { setMembershipId(value); setChanged(true); }}/></label> : null}
      <label className="grid gap-1 text-xs text-muted">{t('timeOff.leaveType')}<ChoicePicker label={t('timeOff.leaveType')} value={typeId} options={types.map(type => ({ value: type.id, label: type.name, color: type.color }))} onValueChange={value => { setTypeId(value); setChanged(true); }}/></label>
      <label className="grid gap-1 text-xs text-muted">{t('timeOff.startDate')}<TextInput required type="date" min={overview.capabilities.canManage ? undefined : futureDate(today)} value={startDate} onChange={event => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value); setChanged(true); }}/></label>
      <label className="grid gap-1 text-xs text-muted">{t('timeOff.endDate')}<TextInput required type="date" min={startDate} value={endDate} onChange={event => { setEndDate(event.target.value); setChanged(true); }}/></label>
    </div>
    {!type ? <p role="status" className="text-xs text-muted">{t('timeOff.typeUnavailableForYear')}</p> : null}
    {type?.pausesAccrual ? <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-ink">{t('timeOff.pausesAccrualHint')}</p> : null}
    {type && !type.consumesBalance ? <p className="text-xs text-muted">{t('timeOff.noBalanceCharge')}</p> : null}
    {!profileReady && !bulkMode ? <p role="status" className="text-xs text-muted">{t('timeOff.profileRequired')}</p> : null}
    <label className="grid gap-1 text-xs text-muted">{t('timeOff.privateNote')}<TextInput maxLength={4000} value={note} onChange={event => { setNote(event.target.value); setChanged(true); }}/></label>
    {overview.capabilities.canManage ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={bulkMode} onChange={event => { setBulkMode(event.target.checked); setChanged(true); }}/>{t('timeOff.assignToPeople')}</label> : null}
    {bulkMode ? <div className="space-y-3 rounded-lg border border-line p-3"><p className="text-xs text-muted">{t('timeOff.bulkHint')}</p><div className="flex flex-wrap gap-1.5">{selected.map(id => <button key={id} type="button" aria-label={t('timeOff.removePerson', { name: overview.members.find(member => member.id === id)?.displayName ?? t('timeOff.person') })} className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent-ink" onClick={() => setSelected(selected.filter(value => value !== id))}>{overview.members.find(member => member.id === id)?.displayName} ×</button>)}</div><ChoicePicker label={t('timeOff.addPerson')} value="" placeholder={t('timeOff.addPerson')} searchable options={overview.members.filter(member => !selected.includes(member.id)).map(member => ({ value: member.id, label: member.displayName, avatarName: member.displayName, avatarUrl: member.avatarUrl }))} onValueChange={value => setSelected([...selected, value])}/><label className="grid gap-1 text-xs text-muted">{t('timeOff.correctionReason')}<TextInput value={reason} maxLength={2000} onChange={event => setReason(event.target.value)}/></label>{types.some(item => item.allowNegative && item.consumesBalance) ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={approveNegative} onChange={event => setApproveNegative(event.target.checked)}/>{t('timeOff.explicitNegativeApproval')}</label> : null}</div> : null}
    {overview.capabilities.canManage && !bulkMode ? <label className="grid gap-1 text-xs text-muted">{t('timeOff.correctionReason')}<TextInput maxLength={2000} value={reason} onChange={event => { setReason(event.target.value); setChanged(true); }}/></label> : null}
    {!bulkMode && preview.isError ? <QueryErrorState error={preview.error} subject="planSave" onRetry={() => void preview.refetch()}/> : bulkMode && bulkPreview.isError ? <QueryErrorState error={bulkPreview.error} subject="planSave" onRetry={() => void bulkPreview.refetch()}/> : previewCurrent && settings ? bulkMode && bulkPreview.data ? <div className="space-y-2">{bulkPreview.data.previews.map(item => <div key={item.membershipId}><h3 className="text-sm font-medium">{overview.members.find(member => member.id === item.membershipId)?.displayName}</h3><LeaveChargeReview preview={item.preview}/><LeaveRecalculationReview preview={item.preview} settings={settings} members={overview.members}/></div>)}</div> : preview.data ? <div className="space-y-2"><LeaveChargeReview preview={preview.data}/><LeaveRecalculationReview preview={preview.data} settings={settings} members={overview.members}/></div> : null : null}
    <p className="text-xs text-muted">{t('timeOff.requestHint')}</p><div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" disabled={!valid}>{t(!previewCurrent ? 'timeOff.reviewCharge' : bulkMode ? 'timeOff.assignAndApprove' : 'timeOff.submitRequest')}</Button><Button type="button" variant="ghost" onClick={onCancel}>{t('timeOff.cancelDraft')}</Button></div></fieldset>
  </form>;
}
