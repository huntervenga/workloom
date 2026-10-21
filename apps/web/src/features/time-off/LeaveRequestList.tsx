import { useCallback, useEffect, useState } from 'react';
import type { PreviewLeaveRequestInput, DecideLeaveRequestInput, LeaveOverviewDto, LeaveRequestDto, UpdateLeaveRequestInput } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { leaveStatusLabel } from './labels';
import { useLeavePreview } from './queries';
import { LeaveChargeReview, LeaveRecalculationReview } from './LeavePreview';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { daysText, futureDate, policyForYear } from './presentation';

function RequestEditor({ request, overview, disabled, onUpdate, onDecision, actorId, onDirtyChange, acknowledgedRequest }: { onDirtyChange: (id: string, dirty: boolean) => void; acknowledgedRequest?: LeaveRequestDto | undefined; request: LeaveRequestDto; overview: LeaveOverviewDto; disabled: boolean; onUpdate: (input: UpdateLeaveRequestInput) => Promise<LeaveRequestDto>; onDecision: (input: DecideLeaveRequestInput) => Promise<LeaveRequestDto>; actorId: string }) {
  const { t } = useTranslation();
  const [startDate, setStartDate] = useState(request.startDate);
  const [endDate, setEndDate] = useState(request.endDate);
  const [note, setNote] = useState(request.note);
  const [reason, setReason] = useState('');
  const [approveNegative, setApproveNegative] = useState(false);
  const [openingRevision, setOpeningRevision] = useState(request.revision);
  const [openingRequest, setOpeningRequest] = useState(request);
  const decide = (input: DecideLeaveRequestInput) => { void onDecision(input).then(accept).catch(() => undefined); };
  const today = overview.members.find(member => member.id === request.membershipId)?.today ?? overview.today;
  const started = request.startDate <= today;
  const ended = request.endDate <= today;
  const mayEdit = overview.capabilities.canManage || !ended && request.membershipId === overview.ownMembershipId && overview.capabilities.canRequest;
  const active = request.status === 'pending' || request.status === 'approved';
  const editDirty = startDate !== openingRequest.startDate || endDate !== openingRequest.endDate || note !== openingRequest.note;
  const dirty = editDirty || reason !== '' || approveNegative;
  useEffect(() => { onDirtyChange(request.id, dirty); return () => onDirtyChange(request.id, false); }, [dirty, onDirtyChange, request.id]);
  useProtectedDraft(dirty);
  const [editPreviewInput, setEditPreviewInput] = useState<PreviewLeaveRequestInput | null>(null);
  const [approvalPreviewInput, setApprovalPreviewInput] = useState<PreviewLeaveRequestInput | null>(null);
  const accept = useCallback((saved: LeaveRequestDto) => { setOpeningRequest(saved); setOpeningRevision(saved.revision); setStartDate(saved.startDate); setEndDate(saved.endDate); setNote(saved.note); setReason(''); setApproveNegative(false); setEditPreviewInput(null); setApprovalPreviewInput(null); }, []);
  useEffect(() => { if (acknowledgedRequest && acknowledgedRequest.revision > openingRevision) accept(acknowledgedRequest); }, [accept, acknowledgedRequest, openingRevision]);
  const editCandidate: PreviewLeaveRequestInput = { membershipId: request.membershipId, typeId: request.typeId, excludeRequestId: request.id, startDate, endDate, note, reason, approveNegative: false };
  const approvalCandidate: PreviewLeaveRequestInput = { membershipId: request.membershipId, typeId: request.typeId, excludeRequestId: request.id, startDate: openingRequest.startDate, endDate: openingRequest.endDate, note: openingRequest.note, reason, approveNegative };
  const editPreview = useLeavePreview(actorId, request.workspaceId, editPreviewInput);
  const approvalPreview = useLeavePreview(actorId, request.workspaceId, approvalPreviewInput);
  const editReviewed = editPreview.isSuccess && JSON.stringify(editCandidate) === JSON.stringify(editPreviewInput);
  const approvalReviewed = approvalPreview.isSuccess && JSON.stringify(approvalCandidate) === JSON.stringify(approvalPreviewInput);

  const changedElsewhere = request.revision !== openingRevision;
  const loadLatest = () => { accept(request); setEditPreviewInput(null); setApprovalPreviewInput(null); };
  if (changedElsewhere && !dirty && !disabled) loadLatest();
  const policy = overview.settings ? policyForYear(overview.settings, Number(request.startDate.slice(0, 4))) : undefined;
  const needsReapproval = !overview.capabilities.canManage && request.status === 'approved' && (policy?.types.find(type => type.id === request.typeId)?.requiresApproval ?? true);
  const negativePossible = policy?.types.some(item => item.allowNegative && item.consumesBalance) ?? false;
  return <div className="mt-3 space-y-3">{changedElsewhere ? <div role="status" className="rounded-lg bg-canvas p-3 text-sm"><p>{t('timeOff.changedElsewhere')}</p><Button type="button" size="sm" disabled={disabled} onClick={loadLatest}>{t('timeOff.loadLatest')}</Button></div> : null}
    {mayEdit && active ? <form onSubmit={event => { event.preventDefault(); if (disabled || editPreview.isFetching) return; if (!editReviewed) { setEditPreviewInput(editCandidate); return; } void onUpdate({ expectedRevision: openingRevision, expectedSourceVersion: editPreview.data?.sourceVersion, startDate, endDate, note, reason }).then(accept).catch(() => undefined); }}><fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs text-muted">{t('timeOff.startDate')}<TextInput type="date" required disabled={!overview.capabilities.canManage && started} min={overview.capabilities.canManage ? undefined : needsReapproval ? request.startDate : futureDate(today)} value={startDate} onChange={event => setStartDate(event.target.value)}/></label><label className="grid gap-1 text-xs text-muted">{t('timeOff.endDate')}<TextInput type="date" required min={overview.capabilities.canManage ? startDate : started ? today : startDate} max={needsReapproval ? request.endDate : undefined} value={endDate} onChange={event => setEndDate(event.target.value)}/></label><label className="grid gap-1 text-xs text-muted sm:col-span-2">{t('timeOff.privateNote')}<TextInput maxLength={4000} disabled={!overview.capabilities.canManage && started} value={note} onChange={event => setNote(event.target.value)}/></label>{overview.capabilities.canManage ? <label className="grid gap-1 text-xs text-muted sm:col-span-2">{t('timeOff.correctionReason')}<TextInput value={reason} maxLength={2000} required={started} onChange={event => setReason(event.target.value)}/></label> : null}{editPreview.isError ? <QueryErrorState error={editPreview.error} subject="timeOffPreview" onRetry={() => void editPreview.refetch()}/> : editReviewed ? <div className="sm:col-span-2"><LeaveChargeReview preview={editPreview.data}/></div> : null}<div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit" size="sm" disabled={!dirty || endDate < startDate || editPreview.isFetching}>{t(editReviewed ? 'timeOff.saveRequest' : 'timeOff.reviewCharge')}</Button><Button type="button" variant="ghost" size="sm" disabled={!dirty} onClick={() => accept(request)}>{t('timeOff.discardChanges')}</Button>{!started || overview.capabilities.canManage ? <Button type="button" variant="ghost" size="sm" disabled={started && reason.trim() === ''} onClick={() => decide({ expectedRevision: openingRevision, decision: 'cancel', reason, approveNegative: false })}>{t('timeOff.cancelRequest')}</Button> : null}</div></fieldset></form> : null}
    {!overview.capabilities.canManage && started ? <p className="text-xs text-muted">{t(ended ? 'timeOff.pastLocked' : 'timeOff.futureTailOnly')}</p> : null}
    {overview.capabilities.canApprove && (request.status === 'pending' || request.status === 'approved' && negativePossible && !request.negativeApproved) ? <fieldset disabled={disabled} className="space-y-2 border-t border-line pt-3">{!(mayEdit && active && overview.capabilities.canManage) ? <label className="grid gap-1 text-xs text-muted">{t('timeOff.correctionReason')}<TextInput value={reason} maxLength={2000} onChange={event => setReason(event.target.value)}/></label> : null}{negativePossible ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={approveNegative} onChange={event => setApproveNegative(event.target.checked)}/>{t('timeOff.explicitNegativeApproval')}</label> : null}{approvalPreview.isError ? <QueryErrorState error={approvalPreview.error} subject="timeOffPreview" onRetry={() => void approvalPreview.refetch()}/> : approvalReviewed && overview.settings ? <div className="space-y-2"><LeaveChargeReview preview={approvalPreview.data}/><LeaveRecalculationReview preview={approvalPreview.data} settings={overview.settings} members={overview.members}/></div> : null}{editDirty ? <p className="text-xs text-muted">{t('timeOff.saveRequestBeforeApproval')}</p> : null}<div className="flex gap-2"><Button type="button" variant="primary" size="sm" disabled={editDirty || approvalPreview.isFetching || request.status === 'approved' && (!approveNegative || reason.trim() === '') || approveNegative && reason.trim() === '' || started && reason.trim() === ''} onClick={() => { if (!approvalReviewed) { setApprovalPreviewInput(approvalCandidate); return; } decide({ expectedRevision: openingRevision, decision: 'approve', reason, approveNegative, expectedSourceVersion: approvalPreview.data?.sourceVersion }); }}>{t(!approvalReviewed ? 'timeOff.reviewApproval' : request.status === 'approved' ? 'timeOff.authorizeNegative' : 'timeOff.approve')}</Button><Button type="button" size="sm" disabled={request.status !== 'pending'} onClick={() => decide({ expectedRevision: openingRevision, decision: 'reject', reason, approveNegative: false })}>{t('timeOff.reject')}</Button></div></fieldset> : null}
  </div>;
}
export function LeaveRequestList({ overview, disabled, onUpdate, onDecision, actorId, acknowledgedRequests = {}, membershipId, onDirtyChange }: { overview: LeaveOverviewDto; disabled: boolean; onUpdate: (requestId: string, input: UpdateLeaveRequestInput) => Promise<LeaveRequestDto>; onDecision: (requestId: string, input: DecideLeaveRequestInput) => Promise<LeaveRequestDto>; actorId: string; acknowledgedRequests?: Readonly<Record<string, LeaveRequestDto>>; membershipId?: string | undefined; onDirtyChange?: ((dirty: boolean) => void) | undefined }) {
  const { t, locale } = useTranslation();
  const [dirtyRequests, setDirtyRequests] = useState<ReadonlySet<string>>(new Set());
  const reportDirty = useCallback((id: string, dirty: boolean) => { setDirtyRequests(current => { if (current.has(id) === dirty) return current; const next = new Set(current); if (dirty) next.add(id); else next.delete(id); return next; }); }, []);
  useEffect(() => { onDirtyChange?.(dirtyRequests.size > 0); }, [dirtyRequests, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const currentRequests = new Map(overview.requests.map(request => [request.id, request]));
  for (const acknowledged of Object.values(acknowledgedRequests)) { if (!overview.capabilities.canManage && acknowledged.membershipId !== overview.ownMembershipId) continue; if (acknowledged.revision >= (currentRequests.get(acknowledged.id)?.revision ?? 0)) currentRequests.set(acknowledged.id, acknowledged); }
  const requests = [...currentRequests.values()].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id));
  const visibleRequests = requests.filter(request => !membershipId || request.membershipId === membershipId);
  // Scope changes are blocked while dirty; render only the selected person’s acknowledged history.
  return <section aria-label={t(membershipId ? 'timeOff.personHistory' : 'timeOff.requests')} className="space-y-3"><div><h2 className="text-base font-semibold">{t(membershipId ? 'timeOff.personHistory' : 'timeOff.requests')}</h2>{membershipId ? <p className="mt-1 text-xs text-muted">{t('timeOff.historyHint')}</p> : null}</div>{visibleRequests.length === 0 ? <p className="text-sm text-muted">{t(membershipId ? 'timeOff.noPersonHistory' : 'timeOff.noRequests')}</p> : null}{visibleRequests.map(request => {
    const member = overview.members.find(member => member.id === request.membershipId);
    const type = overview.settings ? policyForYear(overview.settings, Number(request.startDate.slice(0, 4)))?.types.find(item => item.id === request.typeId) : undefined;
    const chargedDays = daysText(request.chargedDays.reduce((sum, day) => sum + day.microdays, 0), locale);
    return <details key={request.id} className="rounded-xl border border-line bg-surface p-3"><summary className="cursor-pointer list-none space-y-1"><span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="inline-flex items-center gap-2 font-medium"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10" style={{ backgroundColor: type?.color }}/>{type?.name ?? t('timeOff.leaveType')}</span>{!membershipId ? <span className="text-sm text-muted">{member?.displayName ?? t('timeOff.person')}</span> : null}<span className="text-sm tabular-nums text-muted">{request.startDate} → {request.endDate}</span><span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${request.status === 'approved' ? 'bg-accent-soft text-accent-ink' : 'bg-canvas text-muted'}`}>{leaveStatusLabel(request.status)}</span></span><span className="block text-xs text-muted">{t('timeOff.recordedBalanceDays', { days: chargedDays })}</span>{request.note ? <span className="block whitespace-pre-wrap break-words text-sm text-ink-soft">{request.note}</span> : null}</summary><RequestEditor actorId={actorId} request={request} acknowledgedRequest={acknowledgedRequests[request.id]} onDirtyChange={reportDirty} overview={overview} disabled={disabled} onUpdate={input => onUpdate(request.id, input)} onDecision={input => onDecision(request.id, input)}/></details>;
  })}</section>;
}
