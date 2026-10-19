import { workspaceReportQueryInputSchema, type WorkspaceReportQueryInput, type WorkspaceReportSourceDto, type WorkspaceReportSourcesDto } from '@workloom/contracts';
import { Temporal } from 'temporal-polyfill';

export const WORKSPACE_REPORT_QUERY = 'dashboard';
export type DashboardSelection = { kind: 'valid'; input: WorkspaceReportQueryInput } | { kind: 'empty' } | { kind: 'invalid' };

export function hasCurrentCategory(source: WorkspaceReportSourceDto): boolean {
  const grouping = source.report.config.groupBy;
  return grouping.kind === 'category' && source.fields.some(field => field.id === grouping.fieldId && field.type === 'single_select' && field.archivedAt === null);
}
/** Saved stale category IDs are never inherited by a new default selection. Explicit links still fail visibly. */
export function defaultSourceBinding(source: WorkspaceReportSourceDto): WorkspaceReportQueryInput['sources'][number] {
  return { reportId: source.report.id, expectedRevision: source.report.revision, ...(source.report.config.groupBy.kind === 'category' && !hasCurrentCategory(source) ? { categoryFieldId: null } : {}) };
}

/** First eligible report per project supplies explicit field IDs, never matching field names. */
export function defaultDashboardInput(discovery: WorkspaceReportSourcesDto): WorkspaceReportQueryInput | null {
  const projects = [...new Set(discovery.sources.map(source => source.projectId))];
  const sources = projects.slice(0, 20).flatMap(projectId => {
    const reports = discovery.sources.filter(source => source.projectId === projectId);
    const source = reports.find(hasCurrentCategory) ?? reports[0];
    return source ? [defaultSourceBinding(source)] : [];
  });
  if (sources.length === 0) return null;
  return workspaceReportQueryInputSchema.parse({ sources, range: { from: Temporal.PlainDate.from(discovery.today).subtract({ months: 3 }).add({ days: 1 }).toString(), to: discovery.today }, bucket: 'week', people: { kind: 'all_active' }, dateSource: 'due_date', hierarchy: 'all_tasks', completion: 'done_only' });
}

/** Invalid explicit URLs never silently fall back to a different person or data scope. */
export function dashboardSelection(params: URLSearchParams, discovery: WorkspaceReportSourcesDto): DashboardSelection {
  if (!params.has(WORKSPACE_REPORT_QUERY)) {
    const input = defaultDashboardInput(discovery);
    return input ? { kind: 'valid', input } : { kind: 'empty' };
  }
  const values = params.getAll(WORKSPACE_REPORT_QUERY);
  if (values.length !== 1 || !values[0] || values[0].length > 16000) return { kind: 'invalid' };
  try {
    const value: unknown = JSON.parse(values[0]);
    const parsed = workspaceReportQueryInputSchema.safeParse(value);
    if (!parsed.success || parsed.data.expectedSourceVersion !== undefined) return { kind: 'invalid' };
    return { kind: 'valid', input: parsed.data };
  } catch { return { kind: 'invalid' }; }
}

export function dashboardSearch(before: URLSearchParams, input: WorkspaceReportQueryInput): URLSearchParams {
  const parsed = workspaceReportQueryInputSchema.parse(input);
  const next = new URLSearchParams(before);
  next.set(WORKSPACE_REPORT_QUERY, JSON.stringify(parsed));
  return next;
}
