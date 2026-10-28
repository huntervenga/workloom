import { UserAvatar } from '../../shared/UserAvatar';
import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Button, TextInput } from '@workloom/ui';
import type { GenericReportConfig, GenericReportResultDto, MembershipDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { ReportSelect } from './ReportConfigEditor';
import { aggregateQueryOptions } from './queries';
import { isComparisonMeasure } from './effortAttribution';
import { personMetrics } from './dashboardMetrics';
import { reportGroupLabel } from './groupLabel';
import { reportNumber } from './reportFormatting';
import { sortablePersonRows, workTypeDistribution } from './workTypeDistribution';

const PAGE_SIZE = 6;
/** Independent full-scope category sums for just the visible people; no detail-row sums or private capacity reads. */
export function ReportPersonWorkTypes({ actorId, workspaceId, projectId, result, categoryId, members, sections, fields, disabled }: { actorId: string; workspaceId: string; projectId: string; result: GenericReportResultDto; categoryId: string; members: readonly MembershipDto[]; sections: readonly SectionDto[]; fields: readonly TaskFieldDefinitionDto[]; disabled: boolean }) {
 const { t, locale } = useTranslation();
 const [search, setSearch] = useState(''), [sort, setSort] = useState<'name'|'actual'>('name'), [page, setPage] = useState(0);
 const factId = result.config.comparison?.factFieldId ?? '', category = fields.find(field => field.projectId === projectId && field.id === categoryId && field.type === 'single_select' && field.archivedAt === null);
 const supported = !!category && !!factId && result.config.measures.some(measure => isComparisonMeasure(measure, result.config, factId));
 const named = personMetrics(result).map(row => ({ ...row, label: row.key === 'unassigned' ? t('genericReports.unassigned') : members.find(member => member.id === row.key)?.displayName ?? result.capacity?.members.find(member => member.membershipId === row.key)?.displayName ?? t('genericReports.formerMember') }));
 const matched = sortablePersonRows(named.filter(row => row.label.toLocaleLowerCase(locale).includes(search.trim().toLocaleLowerCase(locale))), sort, locale);
 const lastPage = Math.max(0, Math.ceil(matched.length / PAGE_SIZE) - 1), visiblePage = Math.min(page, lastPage), visible = matched.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
 const { capacity: omitted, ...taskConfig } = result.config; void omitted;
 const configs = visible.map(row => ({ ...taskConfig, groupBy: { kind: 'category' as const, fieldId: categoryId }, filters: { ...taskConfig.filters, assignee: row.key === 'unassigned' ? { kind: 'unassigned' as const } : { kind: 'member' as const, membershipId: row.key } } } satisfies GenericReportConfig));
 const queries = useQueries({ queries: configs.map(config => aggregateQueryOptions(actorId, workspaceId, projectId, { config, offset: 0, limit: 1 }, supported && !disabled)) });
 const states = { empty: t('genericReports.personWorkTypes.empty'), unknown: t('genericReports.personWorkTypes.unknown'), zero: t('genericReports.personWorkTypes.zero'), negative: t('genericReports.personWorkTypes.negative'), inconsistent: t('genericReports.personWorkTypes.inconsistent'), ready: '' };
 return <section aria-label={t('genericReports.personWorkTypes.title')} className="space-y-3 rounded-xl border border-line bg-surface p-4">
  <header className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{t('genericReports.personWorkTypes.title')}</h3><p className="mt-1 text-xs text-muted">{t(result.config.comparison?.attribution === 'personal_effort' ? 'effortReports.workTypesHint' : 'genericReports.personWorkTypes.hint', { field: category?.name ?? t('genericReports.unavailableField'), metric: result.fields.find(field => field.id === factId)?.name ?? t('genericReports.unavailableField') })}</p></div><label className="grid w-44 gap-1 text-xs text-muted">{t('genericReports.personWorkTypes.search')}<TextInput value={search} onChange={event => { setSearch(event.target.value); setPage(0); }}/></label><div className="w-36"><ReportSelect label={t('genericReports.personWorkTypes.sort')} value={sort} onChange={value => { setSort(value === 'actual' ? 'actual' : 'name'); setPage(0); }}><option value="name">{t('genericReports.personWorkTypes.name')}</option><option value="actual">{t('genericReports.personWorkTypes.actual')}</option></ReportSelect></div></header>
  {!supported ? <p className="text-sm text-muted">{t('effortReports.workTypesSetup')}</p> : <><div className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">{visible.map((person, index) => {
   const query = queries[index], data = query?.data, distribution = data ? workTypeDistribution(data, factId, categoryId) : null;
   const stops = distribution?.state === 'ready' ? distribution.items.flatMap(item => item.startBps === undefined || item.endBps === undefined ? [] : [`${item.color} ${item.startBps / 100}% ${item.endBps / 100}%`]).join(', ') : '';
   return <article key={person.key} aria-label={t('genericReports.personWorkTypes.person', { name: person.label })} data-work-type-person={person.key} className="min-w-0 space-y-3 rounded-lg border border-line p-3">
    <header className="flex items-baseline justify-between gap-2"><div className="flex min-w-0 items-center gap-2">{person.key !== 'unassigned' ? <UserAvatar name={person.label} seed={person.key} avatarUrl={members.find(member => member.id === person.key)?.avatarUrl} size="sm" /> : null}<h4 title={person.label} className="truncate text-sm font-semibold">{person.label}</h4></div><span className="shrink-0 text-xs text-muted">{t('genericReports.taskCount', { count: person.taskCount })}</span></header>
    {query?.isError ? <QueryErrorState error={query.error} subject="fields" headingLevel={3} onRetry={() => void query.refetch()}/> : distribution && data ? <>
     <div className="flex items-center gap-3"><div aria-hidden="true" data-work-type-ring="" className="relative h-20 w-20 shrink-0 rounded-full bg-canvas" style={stops ? { background: `conic-gradient(${stops})` } : undefined}><div className="absolute inset-3 rounded-full bg-surface"/></div><div className="min-w-0"><p className="break-words text-lg font-semibold tabular-nums">{reportNumber(distribution.total?.value ?? null, distribution.total?.unit ?? 'minutes', true)}</p><p className="text-xs text-muted">{t('genericReports.personWorkTypes.recorded')}</p>{distribution.state !== 'ready' ? <p role="status" className="mt-1 text-xs text-muted">{states[distribution.state]}</p> : null}</div></div>
     {distribution.total ? <p className="text-xs text-muted">{t('genericReports.personWorkTypes.coverage', { filled: distribution.total.coverage.filled, tasks: distribution.total.coverage.tasks })}</p> : null}
     {distribution.items.length ? <ul className="max-h-44 space-y-1.5 overflow-auto text-xs">{distribution.items.map(item => <li key={item.stableKey} className="flex min-w-0 items-baseline gap-2" data-work-type-category={item.stableKey}><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }}/><span className="min-w-0 flex-1 break-words">{reportGroupLabel(data.config, item.stableKey, '', data.fields, members, sections)}</span><span className="shrink-0 tabular-nums">{reportNumber(item.value, distribution.total?.unit ?? 'minutes', true)}{item.percentText ? ` · ${item.percentText}` : ''}</span></li>)}</ul> : null}
    </> : <p role="status" className="text-xs text-muted">{disabled ? t('genericReports.personWorkTypes.paused') : t('genericReports.calculating')}</p>}
   </article>;
  })}</div>{!matched.length ? <p className="text-sm text-muted">{t('genericReports.personWorkTypes.noPeople')}</p> : <footer className="flex flex-wrap items-center justify-end gap-2"><span className="mr-auto text-xs text-muted">{t('genericReports.personWorkTypes.page', { from: visiblePage * PAGE_SIZE + 1, to: visiblePage * PAGE_SIZE + visible.length, total: matched.length })}</span><Button size="sm" variant="ghost" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>{t('genericReports.personWorkTypes.previous')}</Button><Button size="sm" variant="ghost" disabled={visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)}>{t('genericReports.personWorkTypes.next')}</Button></footer>}</>}
 </section>;
}
