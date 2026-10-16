import { t, useTranslation } from '../../i18n';
import type { WorkCategorySnapshot } from '@workloom/contracts';

const missingReasons: Record<Extract<WorkCategorySnapshot, { kind: 'uncategorized' }>['reason'], string> = {
  get legacy() { return t('work-categories.recordedBeforeWorkTypesWereConfigured'); },
  get unbound() { return t('work-categories.noWorkTypeFieldSelected'); },
  get field_unavailable() { return t('work-categories.selectedWorkTypeFieldUnavailable'); },
  get unset() { return t('work-categories.taskHasNoWorkType'); },
  get explicit_clear() { return t('work-categories.categoryExplicitlyRemoved'); },
};

/** Historical labels belong to the work revision; never resolved from current task fields. */
export function CategoryBadge({ category }: { category: WorkCategorySnapshot | undefined }) {
  const { t } = useTranslation();
  if (!category || category.kind === 'uncategorized') {
    return <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted" title={missingReasons[category?.reason ?? 'legacy']}>{t('work-categories.uncategorized')}</span>;
  }
  return <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-ink-soft" title={t('work-categories.capturedWithTheTimeEntry', { fieldLabel: category.fieldLabel })}><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: category.color ?? '#94a3b8' }} aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{category.optionLabel}</span>{category.optionArchivedAt ? <span className="text-muted">{t('work-categories.archived')}</span> : null}</span>;
}
