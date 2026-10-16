import { useTranslation } from '../../i18n';

interface Props {
  period: string;
  person: string;
  task?: string;
}

/** A fixed entry target is context, not a disabled input the user needs to complete. */
export function PlanningEntryContext({ period, person, task }: Props) {
  const { t } = useTranslation();
  return <section aria-label={t('planning.entryContext')} className="rounded-lg bg-canvas px-3 py-2.5">
    <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
      {task !== undefined ? <div className="min-w-0 sm:col-span-2"><dt className="text-muted">{t('planning.task')}</dt><dd className="mt-0.5 font-medium [overflow-wrap:anywhere]">{task}</dd></div> : null}
      <div className="min-w-0"><dt className="text-muted">{t('planning.person')}</dt><dd className="mt-0.5 font-medium [overflow-wrap:anywhere]">{person}</dd></div>
      <div className="min-w-0"><dt className="text-muted">{t('planning.period')}</dt><dd className="mt-0.5 font-medium [overflow-wrap:anywhere]">{period}</dd></div>
    </dl>
  </section>;
}
