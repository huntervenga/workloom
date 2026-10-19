import { useState } from 'react';
import type { GenericReportResultDto, MembershipDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { ReportSelect } from './ReportConfigEditor';
import { ReportDashboard } from './ReportDashboard';
import { ReportDeliveryOverview } from './ReportDeliveryOverview';
import { dashboardSums } from './dashboardConfig';
import { useAggregates } from './queries';
import { QueryErrorState } from '../../shared/QueryErrorState';

/** One dashboard, independent complete server aggregates. Secondary queries never gain private capacity permissions. */
export function ReportDashboardPanels({ actorId, workspaceId, projectId, result, members, sections, fields, disabled, onChoosePeriod, onPersonSelect }: { actorId: string; workspaceId: string; projectId: string; result: GenericReportResultDto; members: readonly MembershipDto[]; sections: readonly SectionDto[]; fields: readonly TaskFieldDefinitionDto[]; disabled: boolean; onChoosePeriod?: () => void; onPersonSelect: (membershipId: string | null) => void }) {
  const { t } = useTranslation();
  const categories = fields.filter(field => field.type === 'single_select' && field.archivedAt === null);
  const [chosenCategoryId, setCategoryId] = useState<string | null>(null);
  const categoryId = chosenCategoryId ?? (result.config.groupBy.kind === 'category' ? result.config.groupBy.fieldId : categories[0]?.id ?? '');
  const { capacity: authorizedCapacity, ...taskConfig } = result.config;
  void authorizedCapacity;
  const augmented = dashboardSums(taskConfig);
  const needsSums = augmented.config.measures.length !== result.config.measures.length;
  const needsPeople = result.config.comparison !== null && (result.config.groupBy.kind !== 'assignee' || needsSums);
  const people = useAggregates(actorId, workspaceId, projectId, { config: { ...augmented.config, groupBy: { kind: 'assignee' } }, offset: 0, limit: 1 }, needsPeople);
  const needsCategory = categoryId !== '' && (!(result.config.groupBy.kind === 'category' && result.config.groupBy.fieldId === categoryId) || needsSums);
  const category = useAggregates(actorId, workspaceId, projectId, { config: { ...augmented.config, groupBy: { kind: 'category', fieldId: categoryId } }, offset: 0, limit: 1 }, needsCategory);
  const status = useAggregates(actorId, workspaceId, projectId, { config: { ...taskConfig, groupBy: { kind: 'status' } }, offset: 0, limit: 1 }, result.config.groupBy.kind !== 'status');
  const personResult = needsPeople ? people.data : result.config.groupBy.kind === 'assignee' ? result : undefined;
  const displayPeople = personResult ? { ...personResult, ...(result.capacity ? { capacity: result.capacity } : {}) } : undefined;
  const categoryResult = needsCategory ? category.data : result.config.groupBy.kind === 'category' && result.config.groupBy.fieldId === categoryId ? result : undefined;
  const delivery = result.config.groupBy.kind === 'status' ? result : status.data;
  const summary = displayPeople ?? result;
  const error = (value: unknown, retry: () => void) => <QueryErrorState error={value} subject="fields" headingLevel={3} onRetry={retry}/>;
  return <section aria-label={t('genericReports.dashboard.unifiedTitle')} className="min-w-0 space-y-4">
    <ReportDashboard result={summary} members={members} sections={sections} summaryOnly {...(onChoosePeriod && !disabled ? { onChoosePeriod } : {})}/>
    {augmented.limited ? <p role="status" className="text-xs text-muted">{t('genericReports.dashboard.measureLimit')}</p> : null}
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
      {result.config.comparison ? <div className="min-w-0">{needsPeople && people.isError ? error(people.error, () => void people.refetch()) : displayPeople ? <ReportDashboard result={displayPeople} members={members} sections={sections} hideSummary {...(!disabled ? { onPersonSelect } : {})}/> : <p role="status" className="text-xs text-muted">{t('genericReports.calculating')}</p>}</div> : null}
      <div className="min-w-0 space-y-4"><section aria-label={t('genericReports.categoryBreakdown')} className="space-y-3"><div className="max-w-72"><ReportSelect label={t('genericReports.categoryBreakdown')} value={categoryId} disabled={disabled} onChange={setCategoryId}><option value="">{t('genericReports.chooseCategoryBreakdown')}</option>{categories.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</ReportSelect></div>{categoryId ? needsCategory && category.isError ? error(category.error, () => void category.refetch()) : categoryResult ? <ReportDashboard result={categoryResult} members={members} sections={sections} hideSummary/> : <p role="status" className="text-xs text-muted">{t('genericReports.calculating')}</p> : <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{t('genericReports.dashboard.categorySetup')}</p>}</section>
      {status.isError && !delivery ? error(status.error, () => void status.refetch()) : delivery ? <ReportDeliveryOverview result={delivery}/> : null}</div>
    </div>
  </section>;
}
