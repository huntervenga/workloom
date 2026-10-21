import { WorkspaceLink as Link } from '../features/workspace/WorkspaceNavigation';
import { useEffect, useRef, useState } from 'react';

import type { WorkspaceReportQueryInput, WorkspaceReportResultDto, WorkspaceReportSourcesDto } from '@workloom/contracts';
import { Button, Skeleton, StateCard, buttonClassName } from '@workloom/ui';
import { BarChart3, RefreshCw } from 'lucide-react';
import { useTranslation } from '../i18n';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useCurrentSearchParams } from '../lib/useCurrentSearchParams';
import { useWorkspaceContext } from './WorkspaceLayout';
import { QueryErrorState } from '../shared/QueryErrorState';
import { DashboardFilters } from '../features/workspace-reports/DashboardFilters';
import { WorkspaceDashboard } from '../features/workspace-reports/WorkspaceDashboard';
import { dashboardSearch, dashboardSelection, defaultDashboardInput, WORKSPACE_REPORT_QUERY } from '../features/workspace-reports/state';
import { useWorkspaceReportResult, useWorkspaceReportSources } from '../features/workspace-reports/queries';
import { reportNumber } from '../features/generic-reports/reportFormatting';

export function WorkspaceReportsPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  useDocumentTitle(t('workspaceReports.pageTitle', { workspace: workspace.name }));
  const discovery = useWorkspaceReportSources(actorId, workspace.id);
  return <div className="min-w-0 space-y-4"><header><h1 className="text-2xl font-semibold tracking-tight">{t('workspaceReports.title')}</h1><p className="mt-1 text-sm text-muted">{t('workspaceReports.subtitle')}</p></header>
    {discovery.isError ? <QueryErrorState error={discovery.error} subject="report" headingLevel={2} onRetry={() => void discovery.refetch()}/> : discovery.data ? <DashboardWorkspace key={`${actorId}:${workspace.id}`} actorId={actorId} workspaceId={workspace.id} weekStart={workspace.weekStart ?? 1} canManageSchedules={workspace.role === 'owner' || workspace.role === 'admin'} discovery={discovery.data} onReloadSources={async () => { const fresh = await discovery.refetch(); return fresh.isSuccess ? fresh.data : null; }}/> : <DashboardLoading/>}
  </div>;
}

function DashboardWorkspace({ actorId, workspaceId, discovery, onReloadSources, canManageSchedules, weekStart }: { actorId: string; workspaceId: string; discovery: WorkspaceReportSourcesDto; onReloadSources: () => Promise<WorkspaceReportSourcesDto | null>; canManageSchedules: boolean; weekStart: number }) {
  const { t } = useTranslation();
  const [params, updateSearch] = useCurrentSearchParams();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [reloadingSources, setReloadingSources] = useState(false);
  const [sourceMissing, setSourceMissing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = dashboardSelection(params, discovery);
  const input = selected.kind === 'valid' ? selected.input : null;
  const result = useWorkspaceReportResult(actorId, workspaceId, input);
  useEffect(() => {
    if (input && !params.has(WORKSPACE_REPORT_QUERY)) updateSearch(before => before.has(WORKSPACE_REPORT_QUERY) ? null : dashboardSearch(before, input), { replace: true });
  }, [input, params, updateSearch]);
  const apply = (next: WorkspaceReportQueryInput) => { updateSearch(before => dashboardSearch(before, next)); };
  const reset = () => { setSourceMissing(false); updateSearch(before => { const fresh = defaultDashboardInput(discovery); if (fresh) return dashboardSearch(before, fresh); const next = new URLSearchParams(before); next.delete(WORKSPACE_REPORT_QUERY); return next; }); };
  const reloadMappings = async () => {
    if (!input || reloadingSources) return;
    const startedSearch = params.toString();
    setReloadingSources(true); setSourceMissing(false);
    try {
      const fresh = await onReloadSources();
      if (!mounted.current || !fresh) return;
      const sources = input.sources.map(binding => { const source = fresh.sources.find(candidate => candidate.report.id === binding.reportId); return source ? { ...binding, expectedRevision: source.report.revision } : null; });
      updateSearch(before => {
        if (before.toString() !== startedSearch) return null;
        if (sources.some(source => source === null)) { setSourceMissing(true); setSourcesOpen(true); return null; }
        return dashboardSearch(before, { ...input, sources: sources.filter((source): source is NonNullable<typeof source> => source !== null) });
      });
    } finally { if (mounted.current) setReloadingSources(false); }
  };
  if (selected.kind === 'invalid') return <StateCard tone="error" role="alert" title={t('workspaceReports.invalidUrl')} actions={<Button onClick={reset}>{t('workspaceReports.reset')}</Button>}/>;
  if (!input) return <StateCard icon={<BarChart3 size={22} aria-hidden="true"/>} title={t('workspaceReports.emptyTitle')} description={t('workspaceReports.emptyHint')} actions={<Link className={buttonClassName({ variant: 'primary' })} to={`/w/${workspaceId}/projects`}>{t('workspaceReports.projects')}</Link>}/>;
  return <div className="space-y-4">
    <DashboardFilters weekStart={weekStart} key={JSON.stringify(input)} discovery={discovery} input={input} busy={result.isFetching} onApply={apply} onReset={reset} sourcesOpen={sourcesOpen} onSourcesOpenChange={setSourcesOpen}/>
    {result.isError ? <div className="space-y-2"><QueryErrorState error={result.error} subject="report" headingLevel={2} onRetry={() => void result.refetch()}/><Button size="sm" disabled={reloadingSources} onClick={() => void reloadMappings()}>{t(reloadingSources ? 'workspaceReports.reloadingSources' : 'workspaceReports.reloadMappings')}</Button>{sourceMissing ? <p role="alert" className="text-sm text-danger">{t('workspaceReports.sourceMissing')}</p> : null}</div> : result.data ? <>
      <div className="flex items-center justify-between gap-2 text-xs text-muted"><p>{input.range.from} – {input.range.to} · {t('workspaceReports.taskCount', { count: result.data.summary.taskCount })}</p><Button size="sm" variant="ghost" disabled={result.isFetching} onClick={() => void result.refetch()}><RefreshCw size={14} className={result.isFetching ? 'motion-safe:animate-spin' : ''} aria-hidden="true"/>{t('workspaceReports.refresh')}</Button></div>
      <WorkspaceDashboard result={result.data} categoryFields={discovery.sources.flatMap(source => source.fields)} capacityAction={canManageSchedules ? <Link to={`/w/${workspaceId}/time-off?tab=people#working-hours`} className="inline-block pt-1 text-xs font-medium text-accent-strong hover:underline">{t('workspaceReports.setupSchedules')}</Link> : <p className="pt-1 text-xs text-muted">{t('workspaceReports.askAdminSchedules')}</p>} onConfigureTypes={() => setSourcesOpen(true)} onPersonSelect={membershipId => { if (membershipId) apply({ ...input, people: { kind: 'selected', membershipIds: [membershipId] } }); }}/>
      <details className="rounded-xl border border-line bg-surface p-3"><summary className="cursor-pointer text-sm font-medium">{t('workspaceReports.methodDetails')}</summary><div className="mt-2 space-y-1 text-xs text-muted"><p>{t(result.data.attribution === 'personal_effort' ? 'effortReports.dateHint' : 'workspaceReports.coverageHint')}</p><p>{t('workspaceReports.excludedDates', { count: result.data.missingDateTasks })}</p><p>{t('workspaceReports.unmapped', { count: result.data.unmappedHomeTasks })}</p></div></details>
      <DashboardTasks key={result.data.sourceVersion} workspaceId={workspaceId} result={result.data}/>
    </> : <DashboardLoading/>}
  </div>;
}
function DashboardLoading() { const { t } = useTranslation(); return <div role="status" className="space-y-3"><span className="sr-only">{t('workspaceReports.loadingResult')}</span><div className="grid grid-cols-3 gap-3"><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/></div><Skeleton className="h-64 w-full"/></div>; }
function DashboardTasks({ workspaceId, result }: { workspaceId: string; result: WorkspaceReportResultDto }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(25);
  return <details className="rounded-xl border border-line bg-surface p-3"><summary className="cursor-pointer text-sm font-medium">{t(result.attribution === 'personal_effort' ? 'effortReports.contributionDetails' : 'workspaceReports.taskDetails')}<span className="ml-2 font-normal text-muted">{result.summary.taskCount}</span></summary><div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th className="p-2">{t('workspaceReports.task')}</th><th className="p-2">{t('workspaceReports.person')}</th><th className="p-2">{t('workspaceReports.date')}</th><th className="p-2 text-right">{t('workspaceReports.plan')}</th><th className="p-2 text-right">{t('workspaceReports.actual')}</th><th className="p-2 text-right">{t('workspaceReports.variance')}</th></tr></thead><tbody>{result.rows.slice(0, limit).map(row => <tr key={row.sourceKey ?? row.taskId} className="border-t border-line"><td className="p-2"><Link className="font-medium text-accent-strong hover:underline" to={`/w/${workspaceId}/projects/${row.homeProjectId}?task=${row.taskId}`}>{row.title}</Link></td><td className="p-2 text-muted">{result.people.find(person => person.membershipId === (row.attributionMembershipId !== undefined ? row.attributionMembershipId : row.primaryAssigneeId))?.displayName ?? t('workspaceReports.unassigned')}</td><td className="p-2 text-muted">{row.date ?? t('workspaceReports.notSet')}</td><td className="p-2 text-right tabular-nums">{row.planMinutes === null ? '—' : reportNumber({ numerator: String(row.planMinutes), denominator: '1', decimal: String(row.planMinutes) }, 'minutes', true)}</td><td className="p-2 text-right tabular-nums">{row.factMinutes === null ? '—' : reportNumber({ numerator: String(row.factMinutes), denominator: '1', decimal: String(row.factMinutes) }, 'minutes', true)}</td><td className="p-2 text-right tabular-nums"><TaskVariance result={result} row={row}/></td></tr>)}</tbody></table></div><p className="mt-2 text-xs text-muted">{t(result.attribution === 'personal_effort' ? 'effortReports.showingContributions' : 'workspaceReports.showingTasks', { shown: Math.min(limit, result.rows.length), total: result.rows.length })}</p>{limit < result.rows.length ? <Button variant="ghost" size="sm" onClick={() => setLimit(value => value + 50)}>{t('workspaceReports.moreTasks')}</Button> : null}</details>;
}

function TaskVariance({ result, row }: { result: WorkspaceReportResultDto; row: WorkspaceReportResultDto['rows'][number] }) {
  const eligible = result.completion === 'all_tasks' || row.statusGroup === 'done';
  if (!eligible || row.planMinutes === null || row.factMinutes === null) return <span>—</span>;
  const difference = BigInt(row.factMinutes) - BigInt(row.planMinutes);
  const value = { numerator: difference.toString(), denominator: '1', decimal: difference.toString() };
  return <span className={difference > 0n ? 'font-medium text-danger' : 'text-muted'}>{difference > 0n ? '+' : ''}{reportNumber(value, 'minutes', true)}</span>;
}
