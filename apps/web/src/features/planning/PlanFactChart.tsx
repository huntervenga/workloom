import { useId } from 'react';
import { formatEstimate } from '../task-table';

/** Display rows adapted from one server report run; never computed from task pages. */
export interface PlanFactChartItem {
  id: string;
  label: string;
  planMinutes: number | null;
  factMinutes: number | null;
}

interface PlanFactChartProps {
  items: readonly PlanFactChartItem[];
  title?: string;
}

/** A visual companion to the report table. Missing hours remain distinct from confirmed zero. */
export function PlanFactChart({ items, title = 'План и факт' }: PlanFactChartProps) {
  const id = useId();
  const maximum = Math.max(60, ...items.flatMap((item) => [item.planMinutes ?? 0, item.factMinutes ?? 0]));
  if (items.length === 0) return null;

  return (
    <figure aria-labelledby={id} className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption id={id} className="text-sm font-semibold text-ink">{title}</figcaption>
        <span className="text-xs text-muted">Общая шкала: {formatEstimate(maximum)}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Личный план и факт за неделю. Пунктир означает отсутствие записи, а не ноль. Расчёт можно раскрыть в таблице.
      </p>
      <div className="space-y-5">
        {items.map((item) => (
          <div key={item.id} className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium [overflow-wrap:anywhere] text-ink">{item.label}</p>
            {([['План', item.planMinutes, '#6366f1'], ['Факт', item.factMinutes, '#0d9488']] as const).map(([label, minutes, color]) => (
              <div key={label} className="grid grid-cols-[2.5rem_minmax(0,1fr)_6.5rem] items-center gap-2 text-xs sm:grid-cols-[3rem_minmax(0,1fr)_8rem]">
                <span className="text-muted">{label}</span>
                <svg viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label={`${item.label}, ${label.toLowerCase()}: ${hours(minutes, label)}`} className="h-4 w-full overflow-visible">
                  <rect width={100} height={16} rx={2} fill="#f1f5f9" />
                  {minutes === null ? (
                    <rect x={0.5} y={1} width={12} height={14} rx={2} fill="none" stroke="#94a3b8" strokeWidth={0.5} strokeDasharray="1 1" />
                  ) : (
                    <rect width={minutes === 0 ? 0.5 : 100 * minutes / maximum} height={16} rx={2} fill={color} />
                  )}
                </svg>
                <span className="text-right tabular-nums text-ink-soft">{hours(minutes, label)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </figure>
  );
}

function hours(minutes: number | null, label: 'План' | 'Факт'): string {
  return minutes === null ? (label === 'План' ? 'Не задан' : 'Не внесено') : formatEstimate(minutes);
}
