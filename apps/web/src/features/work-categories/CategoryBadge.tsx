import type { WorkCategorySnapshot } from '@workloom/contracts';

const missingReasons: Record<Extract<WorkCategorySnapshot, { kind: 'uncategorized' }>['reason'], string> = {
  legacy: 'Запись создана до настройки типов работы',
  unbound: 'Поле типа работы не выбрано',
  field_unavailable: 'Выбранное поле типа работы недоступно',
  unset: 'В задаче не выбран тип работы',
  explicit_clear: 'Категория снята явно',
};

/** Historical labels belong to the work revision; never resolved from current task fields. */
export function CategoryBadge({ category }: { category: WorkCategorySnapshot | undefined }) {
  if (!category || category.kind === 'uncategorized') {
    return <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted" title={missingReasons[category?.reason ?? 'legacy']}>Без категории</span>;
  }
  return <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-ink-soft" title={`${category.fieldLabel} · тип записан вместе с фактом`}><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: category.color ?? '#94a3b8' }} aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{category.optionLabel}</span>{category.optionArchivedAt ? <span className="text-muted">· архив</span> : null}</span>;
}
