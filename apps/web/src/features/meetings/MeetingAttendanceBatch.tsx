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
  if (draft.reason.trim().length > 1000) return 'Причина должна содержать не более 1000 символов.';
  if (draft.status === 'void') {
    if (!base.workLog || !reason) return 'Для отмены существующей записи нужна причина.';
    return { ...guard, kind: 'void', reason };
  }
  if (meeting.state === 'cancelled' && (draft.status !== 'absent' || draft.basis !== 'planned_absence' || !reason)) {
    return 'Для отменённой встречи разрешено только плановое отсутствие с причиной или отмена записи.';
  }
  const actual = draft.status !== 'absent' || draft.basis === 'actual_meeting';
  if (actual && (!meeting.actualStartAt || meeting.actualDurationMinutes === null)) {
    return 'Сначала сохраните фактическое начало и длительность встречи.';
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
      return 'Частичное участие должно быть больше нуля и не превышать фактическую длительность.';
    }
    minutes = parsed.minutes;
    row = { ...guard, kind: 'confirm', status: 'partial', attributionBasis: 'actual_meeting', minutes, reason };
  }
  const old = base.workLog;
  const basis = draft.status === 'absent' ? draft.basis : 'actual_meeting';
  const changed = old && (old.state === 'void' || base.status !== draft.status || old.minutes !== minutes
    || old.attribution.basis !== basis || !sameInstant(old.attribution.plannedStartAt, meeting.plannedStartAt)
    || !sameInstant(old.attribution.actualStartAt, basis === 'actual_meeting' ? meeting.actualStartAt : null));
  if (changed && !reason) return 'Для исправления или восстановления подтверждённого присутствия нужна причина.';
  return row;
}

function statusLabel(row: AttendancePostingInput): string {
  if (row.kind === 'void') return 'Отменить запись';
  if (row.status === 'absent') return row.attributionBasis === 'planned_absence' ? 'Плановое отсутствие · 0 минут' : 'Отсутствовал · 0 минут';
  return row.status === 'present' ? 'Присутствовал всю встречу' : 'Участвовал частично';
}

/** Controlled drafts and the command live above the drawer; opening this view never posts facts. */
export function MeetingAttendanceBatch({ meeting, periodLabel, attendance, members, drafts, onChange, selectedIds, onSelectionChange, mutation, writable, blocked = false, onSaved }: MeetingAttendanceBatchProps) {
  const [validation, setValidation] = useState('');
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
  const own = held?.taskId === meeting.taskId && held.attendanceMode === 'team' ? held : null;
  const locked = !writable || blocked || !!held;
  const roster = attendance.filter(row => row.rosterActive);
  const selected = roster.filter(row => selectedIds.includes(row.id));
  const name = (row: AttendanceDto | undefined) => members.find(member => member.id === row?.membershipId)?.displayName ?? 'Сохранённый участник';
  const review: { row: AttendancePostingInput; name: string }[] = [];
  const errors: string[] = [];
  for (const row of selected) {
    const draft = drafts[row.id] ?? draftFor(row);
    // Never silently replace a held concurrency snapshot with a refetched row.
    if (draft.base.id !== row.id || draft.base.membershipId !== row.membershipId || draft.base.meetingId !== meeting.id) {
      errors.push(`${name(row)}: обновите исходные данные присутствия.`);
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
    if (errors.length) { setValidation(errors[0] ?? 'Проверьте строки присутствия.'); return; }
    if (!review.length || selected.length > 100) { setValidation('Выберите от 1 до 100 строк с явным результатом присутствия.'); return; }
    setValidation('');
    mutation.mutate({ taskId: meeting.taskId, attendanceMode: 'team', input: { expectedMeetingRevision: meeting.revision, periodId: meeting.plannedPeriodId, rows: review.map(item => item.row) } }, { onSuccess: saved });
  };
  return (
    <section aria-label="Присутствие команды" className="space-y-4 rounded-xl border border-line p-4">
      <div className="space-y-2"><h2 className="font-semibold">Присутствие команды</h2><p className="text-sm text-muted">Приглашение не подтверждает присутствие. Подготовьте строки, проверьте результат каждого и отправьте их вместе. Пропущенные строки останутся без изменений.</p></div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={locked || !roster.length} onClick={prepare}>Подготовить присутствие команды</Button>
        {selected.length ? <Button size="sm" disabled={locked || meeting.state === 'cancelled' || !meeting.actualStartAt || meeting.actualDurationMinutes === null} onClick={fillPresent}>Все выбранные присутствовали</Button> : null}
      </div>
      {!own && selectedIds.length ? <fieldset disabled={locked} className="space-y-3"><legend className="mb-2 text-sm font-medium">Проверьте участников команды</legend>{roster.map(row => {
        const draft = drafts[row.id] ?? draftFor(row);
        const selectedRow = selectedIds.includes(row.id);
        const update = (patch: Partial<AttendanceDraft>) => onChange({ ...drafts, [row.id]: { ...draft, ...patch } });
        return <div key={row.id} className="space-y-3 rounded-lg border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={selectedRow} onChange={event => onSelectionChange(event.target.checked ? [...selectedIds, row.id] : selectedIds.filter(id => id !== row.id))} />{name(row)}</label>
          {selectedRow ? <div className="space-y-3">
            <label className="block space-y-1 text-sm">{`Результат команды: ${name(row)}`}<select className={inputClassName()} value={draft.status} onChange={event => update({ status: event.target.value as AttendanceDraft['status'] })}>
              <option value="unknown">Пропустить — не подтверждать</option><option value="present">Присутствовал всю встречу</option><option value="partial">Участвовал частично</option><option value="absent">Отсутствовал · 0 минут</option>{draft.base.workLog ? <option value="void">Отменить запись факта</option> : null}
            </select></label>
            {draft.status === 'partial' ? <label className="block space-y-1 text-sm">{`Время команды, часы: ${name(row)}`}<TextInput inputMode="decimal" value={draft.minutes} onChange={event => update({ minutes: event.target.value })} /></label> : null}
            {draft.status === 'absent' ? <label className="block space-y-1 text-sm">{`Основание отсутствия: ${name(row)}`}<select className={inputClassName()} value={draft.basis} onChange={event => update({ basis: event.target.value as AttendanceDraft['basis'] })}><option value="planned_absence">Плановое отсутствие — без фактического начала</option><option value="actual_meeting">Фактически прошедшая встреча</option></select></label> : null}
            {draft.status !== 'unknown' ? <label className="block space-y-1 text-sm">{`Причина команды: ${name(row)}`}<TextInput aria-label={`Причина команды: ${name(row)}`} maxLength={1000} value={draft.reason} onChange={event => update({ reason: event.target.value })} /><span className="block text-xs text-muted">Для исправления, отмены, восстановления и отсутствия на отменённой встрече нужна причина. Исторический тип работы сохраняется.</span></label> : null}
          </div> : null}
        </div>;
      })}</fieldset> : null}
      {shown.length ? <section aria-label="Проверка командного присутствия" className="space-y-2 rounded-lg bg-canvas p-3">
        <h3 className="text-sm font-semibold">Проверьте перед общей отправкой</h3>
        {own ? <p role="status" className="text-sm">{mutation.pendingCommand ? 'Ждём ответа. Отправленные строки закреплены.' : 'Результат неизвестен. Повторяется только исходная отправка.'}</p> : null}
        <p className="text-xs text-muted">Исходный период: {periodLabel ?? 'Период встречи'}. Версия встречи: {own?.input.expectedMeetingRevision ?? meeting.revision}.</p>
        <ul className="space-y-1 text-sm">{shown.map(({ row, name: label }) => <li key={row.attendanceId}>{label}: {statusLabel(row)}{row.kind !== 'void' ? ` · ${formatEstimate(row.minutes ?? 0)}` : ''}{row.reason ? ` · ${row.reason}` : ''}</li>)}</ul>
        <p className="text-sm">Строк к отправке: {shown.length}. Подтверждаемые минуты: {formatEstimate(confirmedMinutes)}. Отмена записи исключает её из активного факта.</p>
        <p className="text-xs text-muted">Сервер применит все строки одной операцией или отклонит всю отправку. Ноль означает подтверждённое отсутствие; пропуск не означает ноль.</p>
      </section> : null}
      {!own && errors.length ? <p role="status" className="text-sm text-muted">{errors[0]}</p> : null}
      {validation ? <p role="status" className="text-sm text-muted">{validation}</p> : null}
      <SaveFeedback subject="factSave" error={mutation.variables?.taskId === meeting.taskId ? mutation.error : null} uncertainError={own ? mutation.uncertain?.error ?? null : null} />
      {writable && (selectedIds.length > 0 || own) ? <Button variant="primary" disabled={mutation.pendingCommand !== null || (!own && (locked || !review.length || errors.length > 0))} onClick={submit}>{own && mutation.uncertain ? 'Повторить командное присутствие' : 'Подтвердить присутствие команды'}</Button> : null}
    </section>
  );
}
