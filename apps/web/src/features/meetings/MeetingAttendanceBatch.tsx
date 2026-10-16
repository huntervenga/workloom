import { t, useTranslation, type TranslationKey } from '../../i18n';
import type { AttendanceDto, AttendancePostingDto, AttendancePostingInput, MeetingDto, MembershipDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useState } from 'react';
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

/** Controlled drafts and the command live above the drawer; opening this view never posts facts. */
export function MeetingAttendanceBatch({ meeting, periodLabel, attendance, members, drafts, onChange, selectedIds, onSelectionChange, mutation, writable, blocked = false, onSaved }: MeetingAttendanceBatchProps) {
  const { t } = useTranslation();
  const [validation, setValidation] = useState<TranslationKey | 'reviewErrors' | ''>('');
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
  const prepare = () => {
    if (locked) return;
    const next = { ...drafts };
    for (const row of roster) next[row.id] ??= draftFor(row);
    onChange(next);
    onSelectionChange(roster.map(row => row.id));
    setValidation('');
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
    mutation.mutate({ taskId: meeting.taskId, attendanceMode: 'team', input: { expectedMeetingRevision: meeting.revision, periodId: meeting.plannedPeriodId, rows: review.map(item => item.row) } }, { onSuccess: saved });
  };
  return (
    <section aria-label={t('meetings.teamAttendance')} className="space-y-4 rounded-xl border border-line p-4">
      <div className="space-y-2"><h2 className="font-semibold">{t('meetings.teamAttendance')}</h2><p className="text-sm text-muted">{t('meetings.anInvitationDoesNotConfirmAttendanceSelectPeopleChoose')}</p></div>
      <p className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-muted">{meeting.actualStartAt && meeting.actualDurationMinutes !== null ? t('meetings.savedActualDurationHelp', { duration: formatEstimate(meeting.actualDurationMinutes) }) : t('meetings.actualDurationRequiredHelp')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={locked || !roster.length} onClick={prepare}>{t('meetings.selectTeamMembers')}</Button>
        {selected.length ? <Button size="sm" disabled={locked || meeting.state === 'cancelled' || !meeting.actualStartAt || meeting.actualDurationMinutes === null} onClick={fillPresent}>{t('meetings.markSelectedAsAttended')}</Button> : null}
      </div>
      {!own && selectedIds.length ? <fieldset disabled={locked} className="space-y-3"><legend className="mb-2 text-sm font-medium">{t('meetings.reviewSelectedPeople')}</legend>{roster.map(row => {
        const draft = drafts[row.id] ?? draftFor(row);
        const selectedRow = selectedIds.includes(row.id);
        const update = (patch: Partial<AttendanceDraft>) => onChange({ ...drafts, [row.id]: { ...draft, ...patch } });
        return <div key={row.id} className="space-y-3 rounded-lg border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={selectedRow} onChange={event => onSelectionChange(event.target.checked ? [...selectedIds, row.id] : selectedIds.filter(id => id !== row.id))} />{name(row)}</label>
          {selectedRow ? <div className="space-y-3">
            <label className="block space-y-1 text-sm">{t('meetings.attendanceOutcome', { person: name(row) })}<select className={inputClassName()} value={draft.status} onChange={event => update({ status: event.target.value as AttendanceDraft['status'] })}>
              <option value="unknown">{t('meetings.skipLeaveUnconfirmed')}</option><option value="present">{t('meetings.attendedEntireMeeting')}</option><option value="partial">{t('meetings.attendedPartOfMeeting')}</option><option value="absent">{t('meetings.absent0Minutes')}</option>{draft.base.workLog ? <option value="void">{t('meetings.voidTimeEntry')}</option> : null}
            </select></label>
            {draft.status === 'partial' ? <label className="block space-y-1 text-sm">{t('meetings.timeAttendedHours', { person: name(row) })}<TextInput inputMode="decimal" placeholder={t('meetings.partialTimeExample')} value={draft.minutes} onChange={event => update({ minutes: event.target.value })} /></label> : null}
            {draft.status === 'absent' ? <label className="block space-y-1 text-sm">{t('meetings.absenceBasis', { person: name(row) })}<select className={inputClassName()} value={draft.basis} onChange={event => update({ basis: event.target.value as AttendanceDraft['basis'] })}><option value="planned_absence">{t('meetings.plannedAbsenceNoActualStartRequired')}</option><option value="actual_meeting">{t('meetings.meetingThatTookPlace')}</option></select></label> : null}
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
