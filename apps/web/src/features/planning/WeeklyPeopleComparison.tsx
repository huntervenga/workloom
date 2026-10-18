import { useTranslation } from '../../i18n';
import type { WeeklyPlanFactReportRunDto } from '@workloom/contracts';
import { useId } from 'react';
import { formatEstimate } from '../task-table';
import { baselineActualText, coverageText, knownPlanText, sortPeopleByName, varianceText } from './reportSummary';

type SavedPerson = WeeklyPlanFactReportRunDto['byPerson'][number];

/**
 * Every saved person, including added-only and unplanned-only people, in name order. Values are the
 * server's pinned per-person aggregates; nothing is fetched, filtered from loaded rows or ranked.
 */
export function WeeklyPeopleComparison({ people }: { people: readonly SavedPerson[] }) {
  const { t } = useTranslation();
  const id = useId();
  const sorted = sortPeopleByName(people);
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-semibold">{t('reportUX.comparison.title')}</h3>
      <p className="text-xs leading-relaxed text-muted">{t('reportUX.comparison.hint')}</p>
      {sorted.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{t('reportUX.comparison.empty')}</p> : (
        <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[880px] text-left text-sm">
            <caption className="sr-only">{t('reportUX.comparison.caption')}</caption>
            <thead className="border-b border-line bg-canvas text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-3">{t('reportUX.comparison.person')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.plan')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.actual')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.variance')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.coverage')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.added')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.unplanned')}</th>
                <th scope="col" className="px-3 py-3">{t('reportUX.comparison.total')}</th>
              </tr>
            </thead>
            <tbody>{sorted.map((person) => <PersonRow key={person.membershipId} person={person} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PersonRow({ person }: { person: SavedPerson }) {
  const { summary } = person;
  return (
    <tr className="border-b border-line last:border-0">
      <th scope="row" className="max-w-[14rem] px-4 py-3 font-medium [overflow-wrap:anywhere]">{person.memberName}</th>
      <td className="px-3 py-3 tabular-nums">{knownPlanText(summary)}</td>
      <td className="px-3 py-3 tabular-nums">{baselineActualText(summary)}</td>
      <td className="px-3 py-3 tabular-nums">{varianceText(summary)}</td>
      <td className="px-3 py-3 text-xs text-muted">{coverageText(summary)}</td>
      <td className="px-3 py-3 tabular-nums">{formatEstimate(summary.addedActualMinutes)}</td>
      <td className="px-3 py-3 tabular-nums">{formatEstimate(summary.unplannedActualMinutes)}</td>
      <td className="px-3 py-3 tabular-nums">{formatEstimate(summary.totalActualMinutes)}</td>
    </tr>
  );
}
