import type {
  PlanningPeriodDto,
  RecurrenceBindingProgressDto,
  RecurrenceBlockedCode,
  RecurrenceMaterializationResultDto,
  RecurrenceReadinessDto,
} from '@workloom/contracts';
import { Badge, Button, type BadgeTone } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';

export interface RecurrenceReadinessCardProps {
  period: PlanningPeriodDto;
  data: RecurrenceReadinessDto | undefined;
  error: Error | null;
  loading: boolean;
  fetching: boolean;
  /** Outcome of the latest explicit prepare command; shown only when it belongs to `period`. */
  lastResult?: RecurrenceMaterializationResultDto | undefined;
  materializing: boolean;
  /** Another held command owns the write slot; a new prepare must wait. */
  blocked: boolean;
  writable: boolean;
  /** The parent owns the cursor, idempotency key and original period of the command. */
  onPrepare: () => void;
  onRefresh: () => void;
  onOpenSeries: (seriesId: string) => void;
}

type ReadinessState = RecurrenceReadinessDto['state'];

const stateLabels: Record<ReadinessState, string> = {
  complete: 'Встречи подготовлены',
  pending: 'Подготовка не завершена',
  blocked: 'Подготовка остановлена',
};

const stateTones: Record<ReadinessState, BadgeTone> = {
  complete: 'accent',
  pending: 'muted',
  blocked: 'warning',
};

const stateDescriptions: Record<ReadinessState, string> = {
  complete: 'Все встречи серий, которые относятся к этому периоду, подготовлены.',
  pending: 'Часть встреч серий этого периода ещё не подготовлена.',
  blocked: 'Подготовка части встреч остановлена. Её нужно восстановить в настройках серии.',
};

const bindingStateLabels: Record<RecurrenceBindingProgressDto['state'], string> = {
  complete: 'Подготовлена',
  pending: 'Не завершена',
  blocked: 'Остановлена',
};

/** Fixed, payload-free copy for every bounded block code. */
const blockedReasons: Record<RecurrenceBlockedCode, string> = {
  authorization_missing: 'Никто не разрешил подготовку встреч этой серии от своего имени.',
  authorizer_inactive: 'Участник, разрешивший подготовку, больше не состоит в пространстве.',
  authorizer_capability_revoked: 'У участника, разрешившего подготовку, больше нет права изменять задачи.',
  authorization_revision_stale: 'Разрешение на подготовку устарело после изменения серии.',
  cross_period_conflict: 'Встреча серии относится сразу к нескольким выбранным периодам.',
  candidate_limit_exceeded: 'В серии больше встреч, чем можно подготовить за один раз по правилам серии.',
  source_unavailable: 'Данные серии сейчас недоступны для подготовки.',
  unsupported_event_version: 'Запрос на подготовку записан в неподдерживаемом формате.',
};

const authorizationCodes: ReadonlySet<RecurrenceBlockedCode> = new Set([
  'authorization_missing',
  'authorizer_inactive',
  'authorizer_capability_revoked',
  'authorization_revision_stale',
]);

const hintClass = 'text-xs leading-relaxed text-muted';

const pauseNote =
  'Встречи готовятся только в явно выбранных периодах серии. Приостановка серии останавливает лишь фоновую подготовку: встречи всех выбранных периодов остаются в календаре периода, и их можно подготовить здесь.';

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function recoveryHint(code: RecurrenceBlockedCode | null): string {
  if (code !== null && authorizationCodes.has(code)) {
    return 'Участник с правом изменять задачи может открыть серию и разрешить подготовку от своего имени. Права другого человека не используются.';
  }
  return 'Откройте серию, чтобы проверить её расписание и выбранные периоды.';
}

export function RecurrenceReadinessCard({
  period,
  data,
  error,
  loading,
  fetching,
  lastResult,
  materializing,
  blocked,
  writable,
  onPrepare,
  onRefresh,
  onOpenSeries,
}: RecurrenceReadinessCardProps) {
  const headingId = useId();
  const readiness = data !== undefined && sameId(data.periodId, period.id) ? data : undefined;
  const result = lastResult !== undefined && sameId(lastResult.periodId, period.id) ? lastResult : undefined;

  const header = (
    <div className="min-w-0">
      <h3 id={headingId} className="font-semibold">
        Встречи серий в периоде
      </h3>
      <p className="mt-1 text-sm [overflow-wrap:anywhere] text-muted">{period.name}</p>
    </div>
  );

  // A denial hides everything already loaded for this period, including binding controls.
  if (isAccessDenied(error)) {
    return (
      <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        {header}
        <QueryErrorState error={error} subject="planning" headingLevel={3} />
      </section>
    );
  }

  if (error !== null) {
    return (
      <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        {header}
        <QueryErrorState error={error} subject="planning" headingLevel={3} retrying={fetching} onRetry={onRefresh} />
      </section>
    );
  }

  if (readiness === undefined) {
    return (
      <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        {header}
        {loading ? (
          <p role="status" className="text-sm text-muted">
            Проверяем подготовку встреч периода…
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">Состояние подготовки встреч для этого периода ещё не получено.</p>
            <RefreshButton fetching={fetching} onRefresh={onRefresh} />
          </div>
        )}
      </section>
    );
  }

  const canContinue = result !== undefined && result.status === 'pending' && result.nextCursor !== null;
  const needsPrepare = readiness.state !== 'complete' || canContinue;

  // The normal state stays compact; counts, the last run and per-series progress are one click away.
  if (!needsPrepare) {
    return (
      <section aria-labelledby={headingId} aria-busy={fetching || undefined} className="space-y-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {header}
          <Badge tone={stateTones.complete}>{stateLabels.complete}</Badge>
        </div>
        <p className="text-sm leading-relaxed">{stateDescriptions.complete}</p>
        {result !== undefined && result.frozenBaselineIds.length > 0 ? (
          <p role="status" className={hintClass}>
            Подготовка завершена, и исходный план этого периода зафиксирован.
          </p>
        ) : null}
        <details className="rounded-lg border border-line bg-canvas px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Подробнее о подготовке</summary>
          <div className="mt-3 space-y-4 pb-1">
            <ReadinessCounts readiness={readiness} />
            {result !== undefined ? <LastResult result={result} /> : null}
            <BindingList readiness={readiness} onOpenSeries={onOpenSeries} />
            <p className={hintClass}>{pauseNote}</p>
            <RefreshButton fetching={fetching} onRefresh={onRefresh} />
          </div>
        </details>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} aria-busy={fetching || undefined} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {header}
        <Badge tone={stateTones[readiness.state]}>{stateLabels[readiness.state]}</Badge>
      </div>

      <p className="text-sm leading-relaxed">{stateDescriptions[readiness.state]}</p>

      <ReadinessCounts readiness={readiness} />

      {readiness.state !== 'complete' ? (
        <p className={hintClass}>
          Пока подготовка не завершена, исходный план периода не фиксируется: частично подготовленные встречи не создают снимок
          плана.
        </p>
      ) : null}

      {result !== undefined ? <LastResult result={result} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {writable && needsPrepare ? (
          <Button variant="primary" disabled={blocked || materializing} onClick={onPrepare}>
            {materializing ? 'Готовим встречи…' : canContinue ? 'Продолжить подготовку встреч' : 'Подготовить встречи периода'}
          </Button>
        ) : null}
        <RefreshButton fetching={fetching} onRefresh={onRefresh} />
      </div>
      {writable && needsPrepare && blocked && !materializing ? (
        <p role="status" className={hintClass}>
          Сейчас выполняется другая операция. Подготовку можно запустить после её завершения.
        </p>
      ) : null}
      {!writable && needsPrepare ? (
        <p className={hintClass}>Подготовить встречи может участник с правом изменять задачи проекта.</p>
      ) : null}

      {readiness.bindings.length > 0 ? (
        <div className="border-t border-line pt-4">
          <BindingList readiness={readiness} onOpenSeries={onOpenSeries} />
        </div>
      ) : null}

      <p className={`border-t border-line pt-4 ${hintClass}`}>{pauseNote}</p>
    </section>
  );
}

function ReadinessCounts({ readiness }: { readiness: RecurrenceReadinessDto }) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-canvas p-3">
          <dt className="text-xs text-muted">Не подготовлено</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{readiness.missingCount}</dd>
        </div>
        <div className="rounded-lg border border-line bg-canvas p-3">
          <dt className="text-xs text-muted">Остановлено</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{readiness.blockedCount}</dd>
        </div>
      </dl>
      <p className={hintClass}>
        Итоги учитывают весь период. Встречи, отменённые до подготовки, не считаются неподготовленными.
      </p>
    </div>
  );
}

function BindingList({
  readiness,
  onOpenSeries,
}: {
  readiness: RecurrenceReadinessDto;
  onOpenSeries: (seriesId: string) => void;
}) {
  if (readiness.bindings.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Серии периода</h4>
      {readiness.truncated ? (
        <p className={hintClass}>Состояние выше относится ко всему периоду, но список ниже показывает только часть серий.</p>
      ) : null}
      <ul className="space-y-2">
        {readiness.bindings.map((binding, index) => (
          <BindingRow key={binding.bindingId} binding={binding} position={index + 1} onOpenSeries={onOpenSeries} />
        ))}
      </ul>
    </div>
  );
}

function RefreshButton({ fetching, onRefresh }: { fetching: boolean; onRefresh: () => void }) {
  return (
    <Button
      aria-disabled={fetching || undefined}
      onClick={() => {
        if (!fetching) onRefresh();
      }}
    >
      <RefreshCw size={16} aria-hidden="true" className={fetching ? 'motion-safe:animate-spin' : undefined} />
      {fetching ? 'Обновляем…' : 'Обновить состояние'}
    </Button>
  );
}

function LastResult({ result }: { result: RecurrenceMaterializationResultDto }) {
  return (
    <div role="status" className="space-y-1.5 rounded-lg border border-line bg-canvas p-3">
      <p className="text-sm font-medium">Последний запуск подготовки</p>
      <p className="text-sm">
        Подготовлено встреч за этот шаг: <span className="tabular-nums">{result.createdCount}</span>. Это число только последнего
        шага, а не всего периода.
      </p>
      <p className="text-sm">
        Осталось подготовить по данным сервера: <span className="tabular-nums">{result.remainingCount}</span>.
      </p>
      {result.truncated ? <p className={hintClass}>Показана только часть серий. Итоги выше относятся ко всему периоду; полное состояние подготовки проверяйте после обновления.</p> : null}
      {result.status === 'blocked' ? (
        <p className={hintClass}>Подготовка части встреч остановлена. Причины указаны в списке серий ниже.</p>
      ) : null}
      {result.frozenBaselineIds.length > 0 ? (
        <p className={hintClass}>Подготовка завершена, и исходный план этого периода зафиксирован.</p>
      ) : null}
    </div>
  );
}

function BindingRow({
  binding,
  position,
  onOpenSeries,
}: {
  binding: RecurrenceBindingProgressDto;
  position: number;
  onOpenSeries: (seriesId: string) => void;
}) {
  return (
    <li className="space-y-1.5 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Серия {position}</span>
        <Badge tone={stateTones[binding.state]}>{bindingStateLabels[binding.state]}</Badge>
        {binding.state !== 'complete' ? (
          <span className="text-xs text-muted">
            Осталось подготовить: <span className="tabular-nums">{binding.remainingCount}</span>
          </span>
        ) : null}
      </div>
      {binding.state === 'blocked' ? (
        <>
          <p className="text-sm">
            {binding.blockedCode === null ? 'Подготовка остановлена.' : blockedReasons[binding.blockedCode]}
          </p>
          <p className={hintClass}>{recoveryHint(binding.blockedCode)}</p>
          <Button size="sm" onClick={() => onOpenSeries(binding.seriesId)}>
            Открыть серию для восстановления
          </Button>
        </>
      ) : null}
    </li>
  );
}
