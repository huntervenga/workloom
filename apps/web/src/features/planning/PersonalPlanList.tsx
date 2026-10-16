import type { MembershipDto, PeriodCommitmentDto, PlanningPackageDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { useId } from 'react';
import { useTranslation } from '../../i18n';
import { formatEstimate } from '../task-table';

interface Props {
  commitments: readonly PeriodCommitmentDto[];
  packages: readonly PlanningPackageDto[];
  members: readonly MembershipDto[];
  canWrite: boolean;
  canManage: boolean;
  ownMembershipId: string | null;
  onOpen: (commitment: PeriodCommitmentDto) => void;
}

/** Display the saved values and original entry targets; totals and command rules stay with the page. */
export function PersonalPlanList({ commitments, packages, members, canWrite, canManage, ownMembershipId, onOpen }: Props) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="rounded-xl border border-line bg-surface">
    {/* Explicit native roles preserve table navigation when mobile rows use CSS grid. */}
    <table role="table" className="block w-full text-left text-sm md:table">
      <caption className="sr-only">{t('planning.personalPlans')}</caption>
      <thead role="rowgroup" className="sr-only bg-canvas text-xs text-muted md:not-sr-only md:table-header-group">
        <tr role="row"><th role="columnheader" scope="col" className="px-3 py-2 font-medium">{t('planning.planList.workAndPerson')}</th><th role="columnheader" scope="col" className="px-3 py-2 font-medium md:w-44">{t('planning.planList.hours')}</th><th role="columnheader" scope="col" className="px-3 py-2 font-medium md:w-40">{t('planning.planList.status')}</th><th role="columnheader" scope="col" className="px-3 py-2 font-medium md:w-28">{t('planning.planList.details')}</th></tr>
      </thead>
      <tbody role="rowgroup" className="block divide-y divide-line md:table-row-group">
        {commitments.map(item => {
          const work = packages.find(candidate => candidate.id === item.workPackageId)?.title ?? t('planning.savedWork');
          const person = members.find(member => member.id === item.membershipId)?.displayName ?? t('planning.savedPerson');
          const editable = canWrite && (canManage || ownMembershipId === item.membershipId) && item.baselineIds.length === 0;
          const rowId = `${id}-${item.id}`;
          return <tr key={item.id} role="row" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 md:table-row">
            <th role="rowheader" scope="row" className="min-w-0 text-left font-normal [overflow-wrap:anywhere] md:px-3 md:py-2">
              <p id={`${rowId}-work`} className="font-medium">{work}</p>
              <p id={`${rowId}-person`} className="mt-0.5 text-xs text-muted">{person}</p>
            </th>
            <td role="cell" className="col-start-1 row-start-2 min-w-0 md:table-cell md:px-3 md:py-2">
              <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs md:flex-col">
                <div className="flex flex-wrap items-baseline gap-x-1"><dt className="text-muted">{t('planning.planList.plan')}</dt><dd className="font-medium tabular-nums">{item.plannedMinutes === null ? t('planning.planList.notSet') : formatEstimate(item.plannedMinutes)}</dd></div>
                <div className="flex flex-wrap items-baseline gap-x-1"><dt className="text-muted">{t('planning.planList.unallocated')}</dt><dd className="tabular-nums">{item.unallocatedMinutes === null ? t('planning.unknown') : formatEstimate(item.unallocatedMinutes)}</dd></div>
              </dl>
            </td>
            <td role="cell" className="col-start-1 row-start-3 min-w-0 md:table-cell md:px-3 md:py-2">
              <div className="flex flex-wrap gap-1">
                {item.state === 'removed' ? <Badge tone="warning" className="max-w-full" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{t('planning.planList.removed')}</Badge> : null}
                {item.baselineIds.length > 0 ? <Badge tone="muted" className="max-w-full" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{t('planning.baselineSaved')}</Badge> : null}
                {item.classification === 'added' ? <Badge tone="muted" className="max-w-full" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{t('planning.addedAfterBaseline')}</Badge> : null}
              </div>
            </td>
            <td role="cell" className="col-start-2 row-start-1 row-end-4 self-center md:table-cell md:px-3 md:py-2">
              <Button aria-describedby={`${rowId}-work ${rowId}-person`} onClick={() => onOpen(item)}>{editable ? t('planning.editPlan') : t('planning.viewPlan')}</Button>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
