import type { ManualPeriodWorkLogDto, MembershipDto, PlanningPeriodDto, TaskDto } from '@workloom/contracts';
import { Badge, Button, TextInput, inputClassName } from '@workloom/ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimateInput, parseEstimateInput } from '../task-table';
import type { PlanningCommands } from './queries';

export interface FactSession {
  key: string;
  period: PlanningPeriodDto;
  base: ManualPeriodWorkLogDto | null;
  taskId: string;
  membershipId: string;
  hours: string;
  reason: string;
  state: 'active' | 'void';
  stale: boolean;
}
export function factSession(period: PlanningPeriodDto, log: ManualPeriodWorkLogDto | null, membershipId: string, taskId = ''): FactSession {
  return { key: log?.id ?? `new:${period.id}`, period, base: log, taskId: log?.taskId ?? taskId, membershipId: log?.membershipId ?? membershipId, hours: formatEstimateInput(log?.minutes ?? null), reason: '', state: log?.state ?? 'active', stale: false };
}
interface Props {
  session: FactSession | null;
  open: boolean;
  tasks: readonly TaskDto[];
  members: readonly MembershipDto[];
  ownMembershipId: string | null;
  canWriteOthers: boolean;
  writable: boolean;
  fixedContext?: boolean;
  contextNote?: ReactNode;
  mutation: PlanningCommands['setFact'];
  hasMoreTasks: boolean;
  loadingMoreTasks: boolean;
  onLoadTasks: () => void;
  onChange: (session: FactSession) => void;
  onClose: () => void;
  onSaved: (key: string) => void;
  onReload: (session: FactSession) => Promise<ManualPeriodWorkLogDto | null>;
}
export function FactDialog(props: Props) {
  const id = useId();
  const [validation, setValidation] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const { session, mutation } = props;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const heldHere = session && held?.periodId === session.period.id && held.taskId === session.taskId && held.membershipId === session.membershipId ? held : null;
  const blocked = held !== null && heldHere === null;
  if (!session) return null;
  const editable = props.writable && (props.canWriteOthers || props.ownMembershipId === session.membershipId);
  const locked = held !== null;
  const shownHours = heldHere ? formatEstimateInput(heldHere.input.minutes) : session.hours;
  const shownReason = heldHere ? heldHere.input.reason ?? '' : session.reason;
  const shownState = heldHere?.input.state ?? session.state;
  const missingTask = session.taskId && !props.tasks.some((task) => task.id === session.taskId);
  const missingMember = session.membershipId && !props.members.some((member) => member.id === session.membershipId);
  const ownError = mutation.variables?.periodId === session.period.id && mutation.variables.taskId === session.taskId && mutation.variables.membershipId === session.membershipId ? mutation.error : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (heldHere) {
      if (!mutation.pendingCommand && mutation.uncertain) mutation.retryUncertain({ onSuccess: () => props.onSaved(session.key) });
      return;
    }
    if (locked || session.stale || !editable) return;
    const parsed = parseEstimateInput(session.hours);
    if (!parsed.valid || parsed.minutes === null) { setValidation('Введите часы за неделю: например, 5, 1:30 или явный 0.'); return; }
    if (!session.taskId || !session.membershipId) { setValidation('Выберите задачу и участника.'); return; }
    const changed = session.base !== null && (session.base.minutes !== parsed.minutes || session.base.state !== session.state);
    if ((changed || session.state === 'void') && !session.reason.trim()) { setValidation('Для исправления или отмены факта укажите причину.'); return; }
    setValidation(null);
    mutation.mutate({ taskId: session.taskId, periodId: session.period.id, membershipId: session.membershipId, input: { expectedRevision: session.base?.revision ?? null, minutes: parsed.minutes, state: session.state, reason: session.reason.trim() || null } }, {
      onSuccess: () => props.onSaved(session.key),
      onError: (error) => { if (error instanceof ApiError && error.kind === 'conflict') props.onChange({ ...session, stale: true }); },
    });
  };
  const reload = async () => {
    setReloading(true); setReloadFailed(false);
    try { const base = await props.onReload(session); props.onChange({ ...session, base, stale: false }); mutation.reset(); }
    catch { setReloadFailed(true); }
    finally { setReloading(false); }
  };
  return (
    <DialogShell title={session.base ? 'Изменить факт за неделю' : 'Внести факт за неделю'} description={`${session.period.name}. Это личная запись за весь период, без распределения по дням.`} open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
        <Badge tone="muted">За неделю</Badge>
        {props.contextNote}
        {blocked ? <p role="status" className="text-sm text-amber-800">Другая запись факта ещё отправляется или не подтверждена. Сначала разрешите её отправку.</p> : null}
        <fieldset disabled={locked || !editable} className="min-w-0 space-y-4">
          <div className="space-y-1.5"><label htmlFor={`${id}-task`} className="text-sm font-medium">Задача для факта</label><select id={`${id}-task`} className={inputClassName()} value={session.taskId} disabled={session.base !== null || props.fixedContext} onChange={(event) => props.onChange({ ...session, taskId: event.target.value })}><option value="">Выберите задачу</option>{props.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}{missingTask ? <option value={session.taskId}>Сохранённая задача · не загружена</option> : null}</select>{props.hasMoreTasks ? <Button size="sm" disabled={props.loadingMoreTasks} onClick={props.onLoadTasks}>Загрузить ещё задачи для факта</Button> : null}</div>
          <div className="space-y-1.5"><label htmlFor={`${id}-member`} className="text-sm font-medium">Чьи часы</label><select id={`${id}-member`} className={inputClassName()} value={session.membershipId} disabled={session.base !== null || !props.canWriteOthers || props.fixedContext} onChange={(event) => props.onChange({ ...session, membershipId: event.target.value })}><option value="">Выберите участника</option>{props.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}{missingMember ? <option value={session.membershipId}>Сохранённый участник · нет в текущем списке</option> : null}</select></div>
          <div className="space-y-1.5"><label htmlFor={`${id}-hours`} className="text-sm font-medium">Факт за неделю, часы</label><TextInput id={`${id}-hours`} autoFocus={props.fixedContext} value={shownHours} onChange={(event) => props.onChange({ ...session, hours: event.target.value })} inputMode="decimal" placeholder="Например, 5 или 1:30" /><p className="text-xs text-muted">0 подтверждает отсутствие затрат. Пустое поле не заменяется нулём. Эта запись не переписывает часы коллег или другие источники.</p></div>
          {session.base ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shownState === 'void'} onChange={(event) => props.onChange({ ...session, state: event.target.checked ? 'void' : 'active' })} />Отменить эту запись</label> : null}
          <div className="space-y-1.5"><label htmlFor={`${id}-reason`} className="text-sm font-medium">{session.base ? 'Причина исправления' : 'Комментарий, необязательно'}</label><TextInput id={`${id}-reason`} value={shownReason} onChange={(event) => props.onChange({ ...session, reason: event.target.value })} maxLength={1000} /></div>
        </fieldset>
        {validation ? <p role="alert" className="text-sm text-red-700">{validation}</p> : null}
        <SaveFeedback subject="factSave" error={ownError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={session.stale ? <Button size="sm" disabled={reloading} onClick={() => void reload()}>Загрузить актуальную запись</Button> : null} />
        {reloadFailed ? <p role="alert" className="text-sm text-red-700">Не удалось обновить запись. Ваш ввод сохранён.</p> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={props.onClose}>Закрыть</Button>{editable ? <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || blocked || session.stale}>{heldHere ? mutation.pendingCommand ? 'Отправляем…' : 'Повторить отправку' : 'Сохранить факт за неделю'}</Button> : null}</div>
      </form>
    </DialogShell>
  );
}
