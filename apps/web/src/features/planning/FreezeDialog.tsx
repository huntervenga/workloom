import type { FreezePreviewDto, FreezeScope, PlanningPeriodDto } from '@workloom/contracts';
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
}

/** Preview is a full server snapshot. Confirm sends its hash, never a reconstructed client manifest. */
export function FreezeDialog({ workspaceId, request, open, mutation, onClose, onFrozen }: Props) {
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
        {error ? <QueryErrorState error={error} subject="freeze" headingLevel={3} retrying={loading} onRetry={refresh} /> : null}
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
          <p className="text-xs leading-relaxed text-muted">{preview.snapshot.period.protectEstimate ? 'Общая оценка включённых задач будет защищена. ' : ''}{preview.snapshot.period.protectedFieldIds.length > 0 ? 'Выбранные дополнительные поля тоже будут защищены. ' : ''}После фиксации можно добавлять новую работу; сервер отметит её отдельно.</p>
        </> : null}
        <SaveFeedback subject="freeze" error={ownError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={stale ? <Button size="sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />Обновить предпросмотр</Button> : null} />
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={onClose}>Закрыть</Button>{held === null && preview && !stale ? <Button onClick={refresh} disabled={loading}>Обновить предпросмотр</Button> : null}{heldHere || preview?.existingBaselineId === null ? <Button variant="primary" disabled={mutation.pendingCommand !== null || blocked || loading || stale || (!preview && heldHere === null)} onClick={confirm}>{heldHere ? mutation.pendingCommand ? 'Фиксируем…' : 'Повторить отправку' : 'Подтвердить фиксацию'}</Button> : null}</div>
      </div>
    </DialogShell>
  );
}
