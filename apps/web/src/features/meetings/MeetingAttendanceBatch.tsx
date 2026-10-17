import { t, useTranslation, type TranslationKey } from '../../i18n';
import type { AttendanceDto, AttendancePostingDto, AttendancePostingInput, MeetingDto, MembershipDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useId, useState } from 'react';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate, formatEstimateInput, parseEstimateInput } from '../task-table';
import type { MeetingCommands } from './queries';
import type { AttendanceDraft } from './useMeetingWorkspace';

export interface MeetingAttendanceBatchProps {
  meeting: MeetingDto;
  periodLabel?: string | undefined;
  attendance: readonly AttendanceDto[];
  members: readonly MembershipDto[];
  drafts: Record<string, AttendanceDraft>;
  onChange: (drafts: Record<string, AttendanceDraft>) => void;
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  mutation: MeetingCommands['attendance'];
  /** The caller checks the current owner/admin capability. */
  writable: boolean;
  /** Another controller command is pending or uncertain. */
  blocked?: boolean;
  onSaved: (result: AttendancePostingDto, attendanceIds: readonly string[]) => void;
}

function draftFor(row: AttendanceDto): AttendanceDraft {
  return {
    base: row,
    status: row.postingState === 'void' ? 'void' : row.status,
    minutes: formatEstimateInput(row.minutes),
    basis: row.workLog?.attribution.basis ?? 'planned_absence',
    reason: '',
  };
}

/** True when a person's draft holds any input beyond its own saved snapshot. */
export function attendanceDraftEdited(draft: AttendanceDraft): boolean {
  const saved = draftFor(draft.base);
  return draft.status !== saved.status || draft.minutes !== saved.minutes || draft.basis !== saved.basis || draft.reason !== saved.reason;
}

function sameInstant(a: string | null, b: string | null): boolean {
  return a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));
}

function postingFor(draft: AttendanceDraft, meeting: MeetingDto): AttendancePostingInput | string | null {
  const base = draft.base;
  const guard = { attendanceId: base.id, expectedAttendanceRevision: base.revision, expectedWorkLogRevision: base.workLog?.revision ?? null };
  const reason = draft.reason.trim() || null;
  if (draft.status === 'unknown') return null;
  if (draft.reason.trim().length > 1000) return t('meetings.theReasonMustBe1000CharactersOrFewer');
  if (draft.status === 'void') {
    if (!base.workLog || !reason) return t('meetings.giveAReasonToVoidAnExistingEntry');
    return { ...guard, kind: 'void', reason };
  }
  if (meeting.state === 'cancelled' && (draft.status !== 'absent' || draft.basis !== 'planned_absence' || !reason)) {
    return t('meetings.aCancelledMeetingAllowsOnlyPlannedAbsenceWithA');
  }
  const actual = draft.status !== 'absent' || draft.basis === 'actual_meeting';
  if (actual && (!meeting.actualStartAt || meeting.actualDurationMinutes === null)) {
    return t('meetings.saveTheMeetingsActualStartAndDurationFirst');
  }
  let row: AttendancePostingInput;
  let minutes: number;
  if (draft.status === 'absent') {
    minutes = 0;
    row = { ...guard, kind: 'confirm', status: 'absent', attributionBasis: draft.basis, minutes: 0, reason };
  } else if (draft.status === 'present') {
    minutes = meeting.actualDurationMinutes ?? 0;
    row = { ...guard, kind: 'confirm', status: 'present', attributionBasis: 'actual_meeting', minutes, reason };
  } else {
    const parsed = parseEstimateInput(draft.minutes);
    if (!parsed.valid || parsed.minutes === null || parsed.minutes < 1 || parsed.minutes > (meeting.actualDurationMinutes ?? 0)) {
      return t('meetings.partialAttendanceMustBeGreaterThanZeroAndNo');
    }
    minutes = parsed.minutes;
    row = { ...guard, kind: 'confirm', status: 'partial', attributionBasis: 'actual_meeting', minutes, reason };
  }
  const old = base.workLog;
  const basis = draft.status === 'absent' ? draft.basis : 'actual_meeting';
  const changed = old && (old.state === 'void' || base.status !== draft.status || old.minutes !== minutes
    || old.attribution.basis !== basis || !sameInstant(old.attribution.plannedStartAt, meeting.plannedStartAt)
    || !sameInstant(old.attribution.actualStartAt, basis === 'actual_meeting' ? meeting.actualStartAt : null));
  if (changed && !reason) return t('meetings.giveAReasonToCorrectOrRestoreConfirmedAttendance');
  return row;
}

function statusLabel(row: AttendancePostingInput): string {
  if (row.kind === 'void') return t('meetings.voidEntry');
  if (row.status === 'absent') return row.attributionBasis === 'planned_absence' ? t('meetings.plannedAbsence0Minutes') : t('meetings.absent0Minutes');
  return row.status === 'present' ? t('meetings.attendedEntireMeeting') : t('meetings.attendedPartOfMeeting');
}

/** The saved state of one authorized attendance row; unconfirmed is never shown as zero. */
function savedLabel(row: AttendanceDto): string {
  if (row.postingState === 'unconfirmed') return t('meetings.attendanceUnconfirmed');
  if (row.postingState === 'void') return t('meetings.timeEntryVoided');
  const state = row.status === 'absent'
    ? row.workLog?.attribution.basis === 'planned_absence' ? t('meetings.plannedAbsence') : t('meetings.absent')
    : row.status === 'partial' ? t('meetings.partialAttendance') : t('meetings.attended');
  return t('meetings.saved2', { state, hours: formatEstimate(row.minutes ?? 0) });
}

/** Controlled drafts and the command live above the drawer; opening this view never posts facts. */
export function MeetingAttendanceBatch({ meeting, periodLabel, attendance, members, drafts, onChange, selectedIds, onSelectionChange, mutation, writable, blocked = false, onSaved }: MeetingAttendanceBatchProps) {
  const { t } = useTranslation();
  const pickerId = useId();
  const [validation, setValidation] = useState<TranslationKey | 'reviewErrors' | ''>('');
  const [fullNotice, setFullNotice] = useState<{ count: number; kept: number } | null>(null);
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
  const own = held?.taskId === meeting.taskId && held.attendanceMode === 'team' ? held : null;
  const locked = !writable || blocked || !!held;
  const roster = attendance.filter(row => row.rosterActive);
  const selected = roster.filter(row => selectedIds.includes(row.id));
  const name = (row: AttendanceDto | undefined) => members.find(member => member.id === row?.membershipId)?.displayName ?? t('meetings.savedPerson');
  const review: { row: AttendancePostingInput; name: string }[] = [];
  const errors: string[] = [];
  for (const row of selected) {
    const draft = drafts[row.id] ?? draftFor(row);
    // Never silently replace a held concurrency snapshot with a refetched row.
    if (draft.base.id !== row.id || draft.base.membershipId !== row.membershipId || draft.base.meetingId !== meeting.id) {
      errors.push(t('meetings.refreshTheAttendanceSourceData', { person: name(row) }));
      continue;
    }
    const prepared = postingFor(draft, meeting);
    if (typeof prepared === 'string') errors.push(`${name(row)}: ${prepared}`);
    else if (prepared) review.push({ row: prepared, name: name(row) });
  }
  const shown = own ? own.input.rows.map(row => ({ row, name: name(attendance.find(item => item.id === row.attendanceId)) })) : review;
  const confirmedMinutes = shown.reduce((total, { row }) => total + (row.kind === 'void' ? 0 : row.minutes ?? 0), 0);
  const saved = (result: AttendancePostingDto, variables: NonNullable<MeetingCommands['attendance']['variables']>) => onSaved(result, variables.input.rows.map(row => row.attendanceId));
  const actualSaved = meeting.actualStartAt !== null && meeting.actualDurationMinutes !== null;
  // Full attendance is proposed only for people with no saved source yet; edited drafts keep their own controls.
  const unconfirmed = roster.filter(row => row.postingState === 'unconfirmed');
  const fullReady = unconfirmed.filter(row => { const draft = drafts[row.id]; return !draft || !attendanceDraftEdited(draft); });
  const fullKept = unconfirmed.filter(row => { const draft = drafts[row.id]; return !!draft && attendanceDraftEdited(draft) && !selectedIds.includes(row.id); });
  const fullBlocked = locked || meeting.state === 'cancelled' || !actualSaved || fullReady.length === 0;
  const summaryRows = attendance.filter(row => row.rosterActive || row.workLog !== null);
  const reviewIds = new Set(shown.map(({ row }) => row.attendanceId));
  const counts = { present: 0, partial: 0, absent: 0, unconfirmed: 0, void: 0 };
  for (const row of summaryRows) counts[row.postingState === 'active' ? row.status === 'unknown' ? 'unconfirmed' : row.status : row.postingState] += 1;
  const prepare = () => {
    if (locked) return;
    const next = { ...drafts };
    for (const row of roster) next[row.id] ??= draftFor(row);
    onChange(next);
    onSelectionChange(roster.map(row => row.id));
    setValidation('');
    setFullNotice(null);
  };
  const prepareFull = () => {
    if (fullBlocked) return;
    const next = { ...drafts };
    // An untouched draft holds no input, so it is rebuilt from the current row instead of an older snapshot.
    for (const row of fullReady) next[row.id] = { ...draftFor(row), status: 'present', basis: 'actual_meeting' };
    onChange(next);
    onSelectionChange([...new Set([...selectedIds, ...fullReady.map(row => row.id)])]);
    setValidation('');
    setFullNotice({ count: fullReady.length, kept: fullKept.length });
  };
  const fillPresent = () => {
    if (locked) return;
    const next = { ...drafts };
    for (const row of selected) next[row.id] = { ...(drafts[row.id] ?? draftFor(row)), status: 'present', basis: 'actual_meeting' };
    onChange(next);
  };
  const submit = () => {
    if (!writable || mutation.pendingCommand) return;
    if (own && mutation.uncertain) { mutation.retryUncertain({ onSuccess: saved }); return; }
    if (locked) return;
    if (errors.length) { setValidation('reviewErrors'); return; }
    if (!review.length || selected.length > 100) { setValidation('meetings.choose1100RowsWithAnExplicitAttendanceOutcome'); return; }
    setValidation('');
    setFullNotice(null);
    mutation.mutate({ taskId: meeting.taskId, attendanceMode: 'team', input: { expectedMeetingRevision: meeting.revision, periodId: meeting.plannedPeriodId, rows: review.map(item => item.row) } }, { onSuccess: saved });
  };
  const basisOptions: ChoiceOption[] = [
    { value: 'planned_absence', label: t('meetings.plannedAbsenceNoActualStartRequired') },
    { value: 'actual_meeting', label: t('meetings.meetingThatTookPlace') },
  ];
  return (
    <section aria-label={t('meetings.teamAttendance')} className="space-y-4 rounded-xl border border-line p-4">
      <div className="space-y-2"><h2 className="font-semibold">{t('meetings.teamAttendance')}</h2><p className="text-sm text-muted">{t('meetings.anInvitationDoesNotConfirmAttendanceSelectPeopleChoose')}</p></div>
      <p className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-muted">{actualSaved ? t('meetings.savedActualDurationHelp', { duration: formatEstimate(meeting.actualDurationMinutes ?? 0) }) : t('meetings.actualDurationRequiredHelp')}</p>
      {summaryRows.length ? <section aria-label={t('meetings.rosterSummary')} className="space-y-2 rounded-lg border border-line p-3">
        <h3 className="text-sm font-semibold">{t('meetings.rosterSummary')}</h3>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span>{t('meetings.rosterCountAttended', { count: counts.present })}</span>
          <span>{t('meetings.rosterCountPartial', { count: counts.partial })}</span>
          <span>{t('meetings.rosterCountAbsent', { count: counts.absent })}</span>
          <span>{t('meetings.rosterCountUnconfirmed', { count: counts.unconfirmed })}</span>
          {counts.void ? <span>{t('meetings.rosterCountVoided', { count: counts.void })}</span> : null}
        </p>
        <ul className="space-y-1 text-sm">{summaryRows.map(row => <li key={row.id} className="flex flex-wrap gap-x-2"><span className="font-medium">{name(row)}</span><span className="text-muted">{savedLabel(row)}{row.rosterActive ? '' : t('meetings.removedFromRoster')}{reviewIds.has(row.id) ? t('meetings.inReview') : ''}</span></li>)}</ul>
        <p className="text-xs text-muted">{t('meetings.rosterSummaryHelp')}</p>
      </section> : null}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={fullBlocked} onClick={prepareFull}>{t('meetings.prepareFullAttendance')}</Button>
          <Button size="sm" disabled={locked || !roster.length} onClick={prepare}>{t('meetings.selectTeamMembers')}</Button>
          {selected.length ? <Button size="sm" disabled={locked || meeting.state === 'cancelled' || !actualSaved} onClick={fillPresent}>{t('meetings.markSelectedAsAttended')}</Button> : null}
        </div>
        <p className="text-xs text-muted">{meeting.state === 'cancelled' ? t('meetings.prepareFullAttendanceCancelled') : roster.length && !unconfirmed.length ? t('meetings.prepareFullAttendanceNoneLeft') : t('meetings.prepareFullAttendanceHelp')}</p>
        {fullNotice && !own ? <p role="status" className="text-sm text-muted">{t('meetings.prepareFullAttendanceReady', { count: fullNotice.count })}{fullNotice.kept ? ` ${t('meetings.prepareFullAttendanceKeptDrafts', { count: fullNotice.kept })}` : ''}</p> : null}
      </div>
      {!own && selectedIds.length ? <fieldset disabled={locked} className="space-y-3"><legend className="mb-2 text-sm font-medium">{t('meetings.reviewSelectedPeople')}</legend>{roster.map(row => {
        const draft = drafts[row.id] ?? draftFor(row);
        const selectedRow = selectedIds.includes(row.id);
        const update = (patch: Partial<AttendanceDraft>) => onChange({ ...drafts, [row.id]: { ...draft, ...patch } });
        const outcomeId = `${pickerId}-${row.id}-outcome`;
        const basisId = `${pickerId}-${row.id}-basis`;
        const outcomes: ChoiceOption[] = [
          { value: 'unknown', label: t('meetings.skipLeaveUnconfirmed') },
          { value: 'present', label: t('meetings.attendedEntireMeeting') },
          { value: 'partial', label: t('meetings.attendedPartOfMeeting') },
          { value: 'absent', label: t('meetings.absent0Minutes') },
          ...(draft.base.workLog ? [{ value: 'void', label: t('meetings.voidTimeEntry') }] : []),
        ];
        return <div key={row.id} className="space-y-3 rounded-lg border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={selectedRow} onChange={event => onSelectionChange(event.target.checked ? [...selectedIds, row.id] : selectedIds.filter(id => id !== row.id))} />{name(row)}</label>
          {selectedRow ? <div className="space-y-3">
            <div className="space-y-1 text-sm"><label htmlFor={outcomeId} className="block">{t('meetings.attendanceOutcome', { person: name(row) })}</label><ChoicePicker id={outcomeId} label={t('meetings.attendanceOutcome', { person: name(row) })} value={draft.status} options={outcomes} onValueChange={value => update({ status: value as AttendanceDraft['status'] })} /></div>
            {draft.status === 'partial' ? <label className="block space-y-1 text-sm">{t('meetings.timeAttendedHours', { person: name(row) })}<TextInput inputMode="decimal" placeholder={t('meetings.partialTimeExample')} value={draft.minutes} onChange={event => update({ minutes: event.target.value })} /></label> : null}
            {draft.status === 'absent' ? <div className="space-y-1 text-sm"><label htmlFor={basisId} className="block">{t('meetings.absenceBasis', { person: name(row) })}</label><ChoicePicker id={basisId} label={t('meetings.absenceBasis', { person: name(row) })} value={draft.basis} options={basisOptions} onValueChange={value => update({ basis: value as AttendanceDraft['basis'] })} /></div> : null}
            {draft.status !== 'unknown' ? <label className="block space-y-1 text-sm">{t('meetings.attendanceReason', { person: name(row) })}<TextInput aria-label={t('meetings.attendanceReason', { person: name(row) })} maxLength={1000} value={draft.reason} onChange={event => update({ reason: event.target.value })} /><span className="block text-xs text-muted">{t('meetings.aReasonIsRequiredForCorrectionsVoidingRestoringOr')}</span></label> : null}
          </div> : null}
        </div>;
      })}</fieldset> : null}
      {shown.length ? <section aria-label={t('meetings.reviewTeamAttendance')} className="space-y-2 rounded-lg bg-canvas p-3">
        <h3 className="text-sm font-semibold">{t('meetings.reviewBeforeSavingTogether')}</h3>
        {own ? <p role="status" className="text-sm">{mutation.pendingCommand ? t('meetings.waitingForResponseSubmittedRowsAreLocked') : t('meetings.resultUnknownRetrySendsTheOriginalRequestOnly')}</p> : null}
        <p className="text-xs text-muted">{t('meetings.originalPeriodMeetingRevision', { period: periodLabel ?? t('meetings.meetingPeriod'), revision: own?.input.expectedMeetingRevision ?? meeting.revision })}</p>
        <ul className="space-y-1 text-sm">{shown.map(({ row, name: label }) => <li key={row.attendanceId}>{label}: {statusLabel(row)}{row.kind !== 'void' ? ` · ${formatEstimate(row.minutes ?? 0)}` : ''}{row.reason ? ` · ${row.reason}` : ''}</li>)}</ul>
        <p className="text-sm">{t('meetings.rowsToSaveConfirmedTimeVoidingAnEntryRemoves', { count: shown.length, confirmedMinutes: formatEstimate(confirmedMinutes) })}</p>
        <p className="text-xs text-muted">{t('meetings.allRowsAreSavedTogetherOrAllAreRejected')}</p>
      </section> : null}
      {!own && errors.length ? <p role="status" className="text-sm text-muted">{errors[0]}</p> : null}
      {validation ? <p role="status" className="text-sm text-muted">{validation === 'reviewErrors' ? errors[0] ?? t('meetings.checkTheAttendanceRows') : t(validation)}</p> : null}
      <SaveFeedback subject="factSave" error={mutation.variables?.taskId === meeting.taskId ? mutation.error : null} uncertainError={own ? mutation.uncertain?.error ?? null : null} />
      {writable && (selectedIds.length > 0 || own) ? <Button variant="primary" disabled={mutation.pendingCommand !== null || (!own && (locked || !review.length || errors.length > 0))} onClick={submit}>{own && mutation.uncertain ? t('meetings.retryOriginalTeamAttendance') : t('meetings.confirmTeamAttendance')}</Button> : null}
    </section>
  );
}
