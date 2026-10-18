import { useTranslation } from '../../i18n';
import type { PlanningPeriodDto } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { knownOnlyLabel, peopleScopeLabel, savedTime, weekRangeLabel, type SavedPeopleScope } from './reportSummary';

interface Props {
  projectName?: string;
  /** Must already match the saved report's project and period; callers check before rendering. */
  period: PlanningPeriodDto;
  createdAt: string;
  factCutoffAt: string;
  people: SavedPeopleScope;
  /** Weekly reports only; the work-type breakdown has no known-only option. */
  knownOnly?: boolean;
  /** Only from the provided baseline that matches the saved report's own baseline ID. */
  baselineFrozenAt?: string | null;
}

/** Identity of one immutable saved report. Every time uses the period's named zone. */
export function ReportSnapshotHeader({ projectName, period, createdAt, factCutoffAt, people, knownOnly, baselineFrozenAt }: Props) {
  const { t } = useTranslation();
  return (
    <dl aria-label={t('reportUX.header.label')} className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
      {projectName ? <Entry label={t('reportUX.header.project')}>{projectName}</Entry> : null}
      <Entry label={t('reportUX.header.week')}>{t('reportUX.header.weekValue', { period: period.name, range: weekRangeLabel(period) })}</Entry>
      <Entry label={t('reportUX.header.timezone')}>{t('reportUX.header.timezoneValue', { timezone: period.timezone })}</Entry>
      <Entry label={t('reportUX.header.createdAt')}>{savedTime(createdAt, period)}</Entry>
      <Entry label={t('reportUX.header.asOf')}>{savedTime(factCutoffAt, period)}</Entry>
      {baselineFrozenAt ? <Entry label={t('reportUX.header.baselineFrozen')}>{savedTime(baselineFrozenAt, period)}</Entry> : null}
      <Entry label={t('reportUX.header.people')}><SavedPeople people={people} /></Entry>
      {knownOnly === undefined ? null : <Entry label={t('reportUX.header.knownOnly')}>{knownOnlyLabel(knownOnly)}</Entry>}
    </dl>
  );
}

function Entry({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-x-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 font-medium text-ink-soft [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Count first; the saved snapshot names stay one explicit expansion away. */
function SavedPeople({ people }: { people: SavedPeopleScope }) {
  const { t } = useTranslation();
  return (
    <>
      <span>{peopleScopeLabel(people)}</span>
      {people.names.length > 0 ? (
        <details className="mt-1 font-normal">
          <summary className="w-fit cursor-pointer text-accent-ink">{t('reportUX.header.showNames')}</summary>
          <ul className="mt-1 space-y-0.5 text-muted">{people.names.map((name, index) => <li key={`${index}:${name}`}>{name}</li>)}</ul>
        </details>
      ) : null}
    </>
  );
}
