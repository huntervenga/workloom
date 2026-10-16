import { MATERIALIZATION_REQUIRED, type FreezePreviewDto, type FreezeScope, type PlanningPeriodDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table';
import { fetchFreezePreview } from './api';
import type { PlanningCommands } from './queries';

export interface FreezeRequest { period: PlanningPeriodDto; scope: FreezeScope; nonce: number }
interface Props {
  workspaceId: string;
  request: FreezeRequest | null;
  open: boolean;
  mutation: PlanningCommands['freeze'];
  onClose: () => void;
  onFrozen: (periodId: string, baselineId: string) => void;
  /** The period's series meetings are not all prepared; the parent reveals that period's readiness. */
  onMaterializationRequired?: ((periodId: string) => void) | undefined;
}

/** Only the public code is read; recovery goes through the readiness read, never error details. */
function needsMeetings(error: Error | null): boolean {
  return error instanceof ApiError && error.code === MATERIALIZATION_REQUIRED;
}

/** Preview is a full server snapshot. Confirm sends its hash, never a reconstructed client manifest. */
export function FreezeDialog({ workspaceId, request, open, mutation, onClose, onFrozen, onMaterializationRequired }: Props) {
  const [preview, setPreview] = useState<FreezePreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [stale, setStale] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    if (!request) return undefined;
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(null); setPreview(null); setStale(false);
    void fetchFreezePreview(workspaceId, request.period.id, { scope: request.scope }, controller.signal).then((result) => {
      if (active) { setPreview(result); setLoading(false); }
    }).catch((failure: unknown) => {
      if (active) { setError(failure instanceof Error ? failure : new Error('Preview failed')); setLoading(false); }
    });
    return () => { active = false; controller.abort(); };
  }, [workspaceId, request, reloadToken]);
  if (!request) return null;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const heldHere = held?.periodId === request.period.id && held.input.scope === request.scope ? held : null;
  const blocked = held !== null && heldHere === null;
  const ownError = mutation.variables?.periodId === request.period.id && mutation.variables.input.scope === request.scope ? mutation.error : null;
  const refresh = () => { if (held !== null) return; mutation.reset(); setReloadToken((value) => value + 1); };
  const confirmNeedsMeetings = held === null && needsMeetings(ownError);
  // Always the original request's period; preparing never freezes, so a fresh preview follows it.
  const prepareMeetings = onMaterializationRequired && (needsMeetings(error) || confirmNeedsMeetings)
    ? <Button size="sm" variant="primary" onClick={() => onMaterializationRequired(request.period.id)}>Подготовить встречи периода</Button>
    : null;
  const confirm = () => {
    const success = (baseline: { periodId: string; id: string }) => onFrozen(baseline.periodId, baseline.id);
    if (heldHere) {
      if (!mutation.pendingCommand && mutation.uncertain) mutation.retryUncertain({ onSuccess: success });
      return;
    }
    if (!preview || loading || stale || blocked || preview.existingBaselineId !== null) return;
    mutation.mutate({ periodId: request.period.id, input: { scope: request.scope, previewHash: preview.previewHash } }, {
      onSuccess: success,
      onError: (failure) => { if (failure instanceof ApiError && failure.kind === 'conflict') setStale(true); },
    });
  };
  return (
    <DialogShell title={request.scope === 'self' ? 'Зафиксировать мой план' : 'Зафиксировать план проекта'} description={`${request.period.name}. Исходный снимок сохранится отдельно от последующей работы.`} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <div className="mt-5 space-y-4">
        {loading ? <p role="status" className="text-sm text-muted">Загружаем свежий серверный предпросмотр…</p> : null}
        {error && needsMeetings(error) ? <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-sm text-amber-900"><p className="font-medium text-amber-950">Сначала подготовьте встречи периода</p><p className="leading-relaxed">Не все встречи серий этого периода подготовлены, поэтому исходный план пока нельзя зафиксировать. После подготовки запросите свежий предпросмотр.</p><div className="flex flex-wrap gap-2">{prepareMeetings}<Button size="sm" disabled={loading} onClick={refresh}><RefreshCw size={14} aria-hidden="true" />Обновить предпросмотр</Button></div></div> : error ? <QueryErrorState error={error} subject="freeze" headingLevel={3} retrying={loading} onRetry={refresh} /> : null}
        {blocked ? <p role="status" className="text-sm text-amber-800">Другая фиксация ещё не подтверждена. Сначала разрешите её отправку.</p> : null}
        {preview ? <>
          <p className="text-sm text-ink-soft">Сервер проверит этот полный снимок ещё раз при подтверждении. Изменившиеся задачи, часы, поля или участники потребуют нового предпросмотра.</p>
          {preview.existingBaselineId ? <Badge tone="muted">Этот план уже зафиксирован</Badge> : null}
          <section aria-label="Серверный предпросмотр плана" className="space-y-3 rounded-xl border border-line bg-canvas p-3">
            {preview.snapshot.commitments.length === 0 ? <p className="text-sm text-muted">В исходном плане пока нет личных обязательств.</p> : preview.snapshot.commitments.map((item) => {
              const member = preview.snapshot.memberships.find((value) => value.id === item.membershipId);
              const work = preview.snapshot.packages.find((value) => value.id === item.workPackageId);
              return <div key={item.id} className="space-y-1 border-b border-line pb-3 last:border-0 last:pb-0"><p className="text-sm font-medium [overflow-wrap:anywhere]">{work?.title ?? 'Задача'}</p><p className="text-xs text-muted">{member?.displayName ?? 'Участник'} · личный план: {item.plannedMinutes === null ? 'не задан' : formatEstimate(item.plannedMinutes)}{item.state === 'removed' ? ' · убрано из плана' : ''}{item.classification === 'added' ? ' · добавленная работа' : ''}</p>{work ? <p className="text-xs text-muted">Вся работа: {work.estimateMinutes === null ? 'оценка неизвестна' : formatEstimate(work.estimateMinutes)}</p> : null}</div>;
            })}
          </section>
          {preview.snapshot.recurrence ? <section aria-label="Расписание серий в исходном плане" className="space-y-2 rounded-xl border border-line bg-canvas p-3">
            <h3 className="text-sm font-semibold">Расписание серий</h3>
            <p className="text-sm">Запланировано: {preview.snapshot.recurrence.census.filter(item => item.calendarState === 'scheduled').length}. Отменено: {preview.snapshot.recurrence.census.filter(item => item.calendarState === 'cancelled').length}.</p>
            <p className="text-xs leading-relaxed text-muted">В снимке сохраняется календарь встреч, включая отменённые даты и серии с приостановленной фоновой подготовкой. Это отдельно от личных часов: календарная запись сама по себе не добавляет личный план и не фиксирует общую оценку задачи.</p>
            {preview.snapshot.recurrence.census.length > 0 ? <details className="text-sm"><summary className="cursor-pointer font-medium">Посмотреть даты серий</summary><ul className="mt-2 space-y-2">{preview.snapshot.recurrence.census.slice(0, 20).map(item => <li key={item.instanceId} className="text-xs [overflow-wrap:anywhere]">Дата серии {item.occurrenceKey} · {item.resolution.resolvedLocalDate} {item.resolution.resolvedLocalTime} · {item.resolution.provenance.timezone} (UTC{item.resolution.resolvedOffset}) · {item.calendarState === 'cancelled' ? 'отменена' : 'запланирована'}</li>)}</ul>{preview.snapshot.recurrence.census.length > 20 ? <p className="mt-2 text-xs text-muted">Показаны первые 20 из {preview.snapshot.recurrence.census.length} дат. Снимок сохраняет весь календарь периода.</p> : null}</details> : null}
          </section> : null}
          <p className="text-xs leading-relaxed text-muted">{preview.snapshot.period.protectEstimate ? 'Общая оценка включённых задач будет защищена. ' : ''}{preview.snapshot.period.protectedFieldIds.length > 0 ? 'Выбранные дополнительные поля тоже будут защищены. ' : ''}После фиксации можно добавлять новую работу; сервер отметит её отдельно.</p>
        </> : null}
        <SaveFeedback subject="freeze" error={ownError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={stale ? <div className="flex flex-wrap gap-2">{confirmNeedsMeetings ? prepareMeetings : null}<Button size="sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />Обновить предпросмотр</Button></div> : null} />
        {confirmNeedsMeetings ? <p className="text-xs leading-relaxed text-muted">Не все встречи серий этого периода подготовлены. Подготовьте их, затем запросите свежий предпросмотр и подтвердите фиксацию заново.</p> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={onClose}>Закрыть</Button>{held === null && preview && !stale ? <Button onClick={refresh} disabled={loading}>Обновить предпросмотр</Button> : null}{heldHere || preview?.existingBaselineId === null ? <Button variant="primary" disabled={mutation.pendingCommand !== null || blocked || loading || stale || (!preview && heldHere === null)} onClick={confirm}>{heldHere ? mutation.pendingCommand ? 'Фиксируем…' : 'Повторить отправку' : 'Подтвердить фиксацию'}</Button> : null}</div>
      </div>
    </DialogShell>
  );
}
