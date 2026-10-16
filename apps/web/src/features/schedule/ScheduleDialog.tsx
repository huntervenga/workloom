import type { PlanningPeriodDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useNavigate } from 'react-router';
import { isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { ComparisonList } from './ComparisonList';
import { scheduleDraftInput, scheduleConflict, type ScheduleWorkspace } from './useScheduleWorkspace';

export function ScheduleDialog({ controller: c, workspaceId, periods, writable }: { controller: ScheduleWorkspace; workspaceId: string; projectId: string; periods: readonly PlanningPeriodDto[]; writable: boolean }) {
  const navigate = useNavigate();
  const draft = c.active;
  if (!draft) return null;
  const ownHeld = c.held?.draftId === draft.id ? c.held : null;
  const rows = ownHeld ? draft.rows.map(row => { const sent = ownHeld.input.rows.find(item => item.taskId === row.taskId); return sent ? { ...row, startDate: sent.startDate ?? '', dueDate: sent.dueDate ?? '', expectedRevision: sent.expectedRevision } : row; }) : draft.rows;
  const input = scheduleDraftInput(draft);
  const locked = !!c.held || c.rebasing !== null || !writable;
  const error = c.mutation.variables?.draftId === draft.id ? c.mutation.error : null;
  const denied = c.denied || isAccessDenied(error);
  const preview = draft.preview;
  const names = new Map(draft.rows.map(row => [row.taskId, row.title]));
  return <DialogShell variant="drawer" title="Изменить сроки задач" description="Укажите календарные даты, проверьте изменения и примените их одним действием. Оценка, личный план и факт сохраняются." open onOpenChange={open => { if (!open) c.setActiveId(null); }}>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto py-5 [scroll-padding-bottom:1rem]">
      {denied ? <p role="alert" className="text-sm text-muted">Сроки скрыты: доступ не подтверждён. Закройте окно и проверьте доступ в представлении сроков. Черновик сохранён.</p> : <>
        <fieldset disabled={locked} className="space-y-4"><legend className="sr-only">Даты выбранных задач</legend>
          {rows.map(row => <section key={row.taskId} aria-label={`Сроки: ${row.title}`} className="space-y-3 rounded-xl border border-line p-3"><h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{row.title}</h3>{!row.editable ? <p className="text-xs text-muted">Обычные даты этой задачи недоступны. Для встречи используйте календарь, для архивной задачи — карточку.</p> : null}<div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Дата начала<TextInput type="date" min="0001-01-01" max="9999-12-31" value={row.startDate} disabled={!row.editable} onChange={e => c.change(draft.id, row.taskId, { startDate: e.target.value })} /></label><label className="space-y-1 text-sm font-medium">Срок<TextInput type="date" min="0001-01-01" max="9999-12-31" value={row.dueDate} disabled={!row.editable} onChange={e => c.change(draft.id, row.taskId, { dueDate: e.target.value })} /></label></div><p className="text-xs text-muted">Пустое поле явно убирает дату. Срок включается в диапазон.</p></section>)}
          <div className="flex flex-wrap gap-2"><Button disabled={rows.some(row => !row.editable)} onClick={() => c.shift(draft.id, -1)}>Сдвинуть на день назад</Button><Button disabled={rows.some(row => !row.editable)} onClick={() => c.shift(draft.id, 1)}>Сдвинуть на день вперёд</Button></div>
        </fieldset>
        {!input ? <p role="alert" className="text-sm text-red-800">Проверьте даты: начало не позже срока, допустимые годы 0001–9999, максимум 100 задач.</p> : null}
        {c.previewing === draft.id ? <p role="status" className="text-sm text-muted">Проверяем текущие даты и зависимости…</p> : null}
        <SaveFeedback subject="taskSave" error={draft.error ?? error} uncertainError={ownHeld ? c.mutation.uncertain?.error ?? null : null} />
        {(scheduleConflict(error) || scheduleConflict(draft.error)) && !c.held ? <div className="space-y-2"><p className="text-xs text-muted">Источники изменились. Обновите версии, сохранив введённые даты, затем проверьте изменения заново.</p><Button disabled={c.rebasing !== null} onClick={() => void c.rebase(draft)}>Обновить версии, сохранив даты</Button></div> : null}
        {preview ? <section aria-label="Проверка изменения сроков" className="space-y-4"><h3 className="font-semibold">Проверьте изменения</h3><ul className="space-y-3">{preview.rows.map(row => <li key={row.taskId} className="rounded-lg border border-line p-3 text-sm"><p className="font-medium [overflow-wrap:anywhere]">{names.get(row.taskId) ?? 'Выбранная задача'}</p><p className="mt-1 text-xs text-muted">Было: {row.before.startDate ?? 'Без начала'} — {row.before.dueDate ?? 'Без срока'}</p><p className="mt-1 text-xs">Станет: {row.after.startDate ?? 'Без начала'} — {row.after.dueDate ?? 'Без срока'}{row.changed ? '' : ' · без изменений'}</p></li>)}</ul>
          {preview.protectedTargets.length ? <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>Эти сроки нельзя применить:</p>{preview.protectedTargets.map(target => <p key={target.taskId}>{names.get(target.taskId) ?? 'Выбранная задача'} · {target.reason === 'meeting_task' ? 'откройте календарь встречи' : 'сначала восстановите архивную задачу'}</p>)}</div> : null}
          {preview.recoveryPeriodIds.length ? <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>Сначала подготовьте встречи и актуальное состояние периодов. Затем вернитесь и проверьте сроки заново.</p>{preview.recoveryPeriodIds.map((id, index) => <Button key={id} size="sm" disabled={c.openingRecovery !== null} onClick={() => { void c.resolveRecoveryPeriod(draft, id).then(route => { if (route) void navigate(route); }); }}>Открыть период: {periods.find(period => period.id === id)?.name ?? `период ${index + 1}`}</Button>)}</div> : null}
          <ComparisonList comparisons={preview.comparisons} names={names} workspaceId={workspaceId} />
        </section> : null}
      </>}
      {c.held && !ownHeld ? <p role="status" className="text-sm text-amber-900">Другая отправка сроков ещё не подтверждена. Её исходные даты и ключ сохранены.</p> : null}
      {ownHeld ? <p role="status" className="text-sm text-amber-900">Показаны исходные отправленные даты. Они закреплены до подтверждения результата.</p> : null}
    </div>
    <div role="group" aria-label="Действия со сроками" className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface pt-4"><Button disabled={!!ownHeld} onClick={() => c.discard(draft.id)}>Удалить черновик сроков</Button><Button onClick={() => c.setActiveId(null)}>Закрыть</Button>{ownHeld && c.mutation.uncertain ? <Button variant="primary" disabled={!!c.mutation.pendingCommand} onClick={() => c.mutation.retryUncertain()}>Повторить исходные сроки</Button> : <><Button disabled={locked || denied || !input || c.previewing !== null} onClick={() => void c.preview(draft)}>Проверить изменения</Button><Button variant="primary" disabled={locked || denied || !input || !preview || c.previewing !== null || !!preview.protectedTargets.length || !!preview.recoveryPeriodIds.length || !!error} onClick={() => c.apply(draft)}>Применить сроки</Button></>}</div>
  </DialogShell>;
}

export function ScheduleNotices({ controller: c }: { controller: ScheduleWorkspace }) {
  return <>{c.held ? <div role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>Изменение сроков {c.mutation.pendingCommand ? 'отправляется' : 'не подтверждено'}. Исходные задачи, даты и ключ сохранены.</p><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { if (c.held) c.setActiveId(c.held.draftId); }}>Открыть исходные сроки</Button>{c.mutation.uncertain ? <Button size="sm" onClick={() => c.mutation.retryUncertain()}>Повторить исходную отправку сроков</Button> : null}</div></div> : null}{Object.values(c.drafts).filter(draft => draft.id !== c.activeId && draft.id !== c.held?.draftId).map(draft => <div key={draft.id} className="flex flex-wrap items-center gap-2 text-xs text-muted"><span>Черновик сроков · {draft.rows.length} задач</span><Button size="sm" onClick={() => c.setActiveId(draft.id)}>Продолжить сроки</Button><Button size="sm" onClick={() => c.discard(draft.id)}>Удалить черновик</Button></div>)}</>;
}
