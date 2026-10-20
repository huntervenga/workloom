import type { GenericReportNumberDto, PlanningCheckAssessmentDto, PlanningCheckCheckpointDto, PlanningCheckCheckpointHeaderDto, PlanningCheckConfigDto, PlanningCheckCountsDto, PlanningCheckGroupResultDto, PlanningCheckRuleResultDto } from '@workloom/contracts';
import { reportNumber } from '../generic-reports/reportFormatting';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, TextInput } from '@workloom/ui';
import { t, useTranslation } from '../../i18n';
import { ApiError, isAccessDenied } from '../../lib/api';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { PlanningCheckIssuesDialog } from './PlanningCheckIssuesDialog';
import { usePlanningCheckAssessment, usePlanningCheckCheckpoint, usePlanningCheckCheckpoints, usePlanningCheckCommands, usePlanningCheckSettings } from './queries';

/** Project checks have their own configured scope; saved report filters never reclassify their findings. */
export function PlanningChecksReport({ actorId, workspaceId, projectId, projectRevision, canManage, disabled = false, enabled = true }: { actorId: string; workspaceId: string; projectId: string; projectRevision: number; canManage: boolean; disabled?: boolean; enabled?: boolean }) {
 const { t, formatDate } = useTranslation(), navigate = useNavigate();
 const settings = usePlanningCheckSettings(actorId, workspaceId, projectId, enabled);
 const current = usePlanningCheckAssessment(actorId, workspaceId, projectId, settings.isSuccess && !settings.isError ? { expectedSettingsRevision: settings.data.revision } : null, enabled, projectRevision);
 const [historyOffset, setHistoryOffset] = useState(0), [checkpointId, setCheckpointId] = useState<string|null>(null);
 const history = usePlanningCheckCheckpoints(actorId, workspaceId, projectId, { offset: historyOffset, limit: 50 }, enabled && settings.isSuccess);
 const checkpoint = usePlanningCheckCheckpoint(actorId, workspaceId, projectId, checkpointId, enabled);
 const [issue, setIssue] = useState<{ ruleId: string; offset: number; sourceVersion: string; revision: number } | null>(null);
 const command = usePlanningCheckCommands(actorId, workspaceId, projectId).capture;
 const [captureOpen, setCaptureOpen] = useState(false), [name, setName] = useState('');
 const held = command.pendingCommand !== null || command.uncertain !== null;
 useProtectedDraft(captureOpen && name !== '');
 const denied = [settings.error,current.error,history.error,checkpoint.error].some(error => isAccessDenied(error) || error instanceof ApiError && error.kind === 'unauthenticated');
 const active = !settings.isFetching && !current.isFetching && current.isSuccess && !current.isError && settings.isSuccess && current.data.settingsRevision === settings.data.revision ? current.data : null;
 const canCapture = canManage && enabled && !disabled && !denied && !held && !settings.isFetching && !current.isFetching && active?.enabled === true && checkpointId === null;
 const accepted = (saved:PlanningCheckCheckpointDto) => { setCaptureOpen(false); setName(''); setIssue(null); setHistoryOffset(0); setCheckpointId(saved.id); };
 const refresh = () => { if(held)return;setIssue(null); if(!command.uncertain)command.reset();void settings.refetch();void current.refetch();void history.refetch();if(checkpointId)void checkpoint.refetch(); };
 const openCheckpoint = (id:string) => {if(held || captureOpen)return;setIssue(null);setCheckpointId(id);};
 if(!enabled) return null;
 return <section aria-label={t('genericReports.checksReport.panelTitle')} className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-3">
  <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('genericReports.checksReport.panelTitle')}</h2><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={held || settings.isFetching || current.isFetching} onClick={refresh}>{t('genericReports.checksReport.refresh')}</Button>{canManage ? <Link className="self-center text-xs font-medium text-accent-strong hover:underline" to={`/w/${workspaceId}/projects/${projectId}?checks=1`}>{t('genericReports.checksReport.configure')}</Link> : null}{canManage ? <Button size="sm" disabled={!canCapture} onClick={()=>setCaptureOpen(true)}>{t('genericReports.checksReport.capture')}</Button> : null}</div></header>
  {denied ? <QueryErrorState error={[settings.error,current.error,history.error,checkpoint.error].find(error => isAccessDenied(error) || error instanceof ApiError && error.kind === 'unauthenticated')} subject="project" onRetry={refresh}/> : <>
   {checkpointId ? checkpoint.isError ? <QueryErrorState error={checkpoint.error} subject="fields" onRetry={()=>void checkpoint.refetch()}/> : checkpoint.data ? <>
    <fieldset disabled={held || captureOpen} className="min-w-0"><PlanningCheckReportView assessment={checkpoint.data.assessment} config={checkpoint.data.config} selectedCheckpoint={checkpoint.data} historical showHistory={false} checkpoints={history.data?.rows??[]} historyTotal={history.data?.total??0} onOpenCheckpoint={openCheckpoint} onCurrent={()=>{setCheckpointId(null);setIssue(null);}} onIssues={()=>undefined}/></fieldset>
    <p className="text-xs text-muted">{t('genericReports.checksReport.checkpointMeta',{name:checkpoint.data.name,at:formatDate(checkpoint.data.capturedAt,{dateStyle:'medium',timeStyle:'short',timeZone:checkpoint.data.assessment.timezone})})}</p>
   </> : <p role="status" className="text-xs text-muted">{t('genericReports.checksReport.loadingCheckpoint')}</p> : settings.isError ? <QueryErrorState error={settings.error} subject="fields" onRetry={refresh}/> : current.isError ? <QueryErrorState error={current.error} subject="fields" onRetry={refresh}/> : !active || !settings.data ? <p role="status" className="text-xs text-muted">{t('genericReports.checksReport.loading')}</p> :
    <fieldset disabled={held || captureOpen} className="min-w-0"><PlanningCheckReportView assessment={active} config={settings.data.config} historical={false} showHistory={false} checkpoints={history.data?.rows??[]} historyTotal={history.data?.total??0} onOpenCheckpoint={openCheckpoint} onCurrent={()=>undefined} onIssues={ruleId=>{if(!held&&!captureOpen)setIssue({ruleId,offset:0,sourceVersion:active.sourceVersion,revision:active.settingsRevision});}}/></fieldset>}
   {history.isError ? <QueryErrorState error={history.error} subject="fields" onRetry={()=>void history.refetch()}/> : history.isPending ? <p role="status" className="text-xs text-muted">{t('genericReports.checksReport.loadingHistory')}</p> : <fieldset disabled={held || captureOpen} className="min-w-0"><PlanningCheckHistory checkpoints={history.data?.rows??[]} historyTotal={history.data?.total??0} selectedId={checkpointId} onOpenCheckpoint={openCheckpoint}/></fieldset>}
   {history.data && history.data.total>50 ? <div className="flex items-center gap-2 text-xs"><Button size="sm" variant="ghost" disabled={historyOffset===0 || history.isFetching || held || captureOpen} onClick={()=>setHistoryOffset(Math.max(0,historyOffset-50))}>{t('genericReports.checksReport.previousHistory')}</Button><span className="text-muted">{t('genericReports.checksReport.historyPage',{from:historyOffset+1,to:historyOffset+history.data.rows.length,total:history.data.total})}</span><Button size="sm" variant="ghost" disabled={historyOffset+history.data.rows.length>=history.data.total || history.isFetching || held || captureOpen} onClick={()=>setHistoryOffset(historyOffset+50)}>{t('genericReports.checksReport.nextHistory')}</Button></div> : null}
  </>}
  {checkpointId ? <Button size="sm" variant="ghost" disabled={held || captureOpen} onClick={()=>{setCheckpointId(null);setIssue(null);}}>{t('genericReports.checksReport.returnCurrent')}</Button> : null}
  <PlanningCheckIssuesDialog key={issue ? `${issue.ruleId}:${issue.sourceVersion}` : 'closed'} actorId={actorId} workspaceId={workspaceId} projectId={projectId} input={issue && checkpointId===null && !denied ? {ruleId:issue.ruleId,expectedSettingsRevision:issue.revision,expectedSourceVersion:issue.sourceVersion} : null} name={settings.data?.config.rules.find(rule=>rule.id===issue?.ruleId)?.name??''} onClose={()=>setIssue(null)} onOpenTask={id=>{setIssue(null);navigate(`/w/${workspaceId}/projects/${projectId}?task=${id}`);}} onRefresh={refresh}/>
  {captureOpen ? <form className="flex flex-wrap items-end gap-2 border-t border-line pt-3" onSubmit={event=>{event.preventDefault();if(!canCapture || !active || !name.trim() || command.hasOtherProtectedCommands())return;command.mutate({input:{name:name.trim(),expectedSettingsRevision:active.settingsRevision,expectedSourceVersion:active.sourceVersion}},{onSuccess:accepted});}}><label className="grid min-w-48 flex-1 gap-1 text-xs text-muted">{t('genericReports.checksReport.captureName')}<TextInput value={name} maxLength={160} disabled={held || !canManage} onChange={event=>setName(event.target.value)}/></label><Button size="sm" type="submit" disabled={!canCapture || !name.trim()}>{t('genericReports.checksReport.confirmCapture')}</Button><Button size="sm" type="button" variant="ghost" disabled={held} onClick={()=>{setCaptureOpen(false);setName('');command.reset();}}>{t('common.cancel')}</Button><p className="basis-full text-xs text-muted">{t('genericReports.checksReport.captureHint')}</p></form> : null}
  <SaveFeedback error={command.error} uncertainError={command.uncertain?.error??null} subject="fieldValueSave"/>{command.uncertain ? <Button size="sm" disabled={!canManage || command.pendingCommand!==null || disabled || denied} onClick={()=>command.retryUncertain({onSuccess:accepted})}>{t('genericReports.checksReport.retryExact')}</Button> : null}
 </section>;
}



type Assessment = PlanningCheckAssessmentDto | PlanningCheckCheckpointDto['assessment'];
type Metric = Exclude<keyof PlanningCheckCountsDto, 'eligibleTasks' | 'unavailableRules'>;
type Status = { kind: 'off' } | { kind: 'unavailable' } | { kind: 'on'; unavailable: number };
type Unit = PlanningCheckGroupResultDto['unit'];
type Appearance = PlanningCheckRuleResultDto['appearance'];
export type PlanningCheckReportViewProps = { selectedCheckpoint?: PlanningCheckCheckpointHeaderDto | null; showHistory?: boolean; assessment: Assessment; config: PlanningCheckConfigDto; historical: boolean; checkpoints: PlanningCheckCheckpointHeaderDto[]; historyTotal: number; onOpenCheckpoint: (id: string) => void; onCurrent: () => void; onIssues: (ruleId: string) => void };

const metrics: readonly Metric[] = ['missingRequiredTasks', 'overdueTasks', 'underplannedGroups', 'overplannedGroups'];
const dash = '—', hexColor = /^#[0-9a-fA-F]{6}$/, historyPage = 50;
const head = 'py-1 pr-2 text-left font-medium text-muted', cell = 'py-1 pr-2 align-top';
const wholeMinutes = (minutes: number): GenericReportNumberDto => ({ numerator: String(minutes), denominator: '1', decimal: String(minutes) });
const amount = (value: GenericReportNumberDto | null, unit: Unit) => value ? reportNumber(value, unit, true) : dash;

/** A headline count is off when no enabled rule feeds it, and unavailable (never a fake zero) when every feeding rule is unavailable. */
function metricStatus(metric: Metric, config: PlanningCheckConfigDto, assessment: Assessment): Status {
  if (!config.enabled || !assessment.enabled) return { kind: 'off' };
  const ids = new Set(config.rules.filter(rule => rule.enabled && (metric === 'missingRequiredTasks' ? rule.kind === 'presence' : metric === 'overdueTasks' ? rule.kind === 'overdue' : rule.kind === 'balance' && (metric === 'underplannedGroups' ? rule.under.enabled : rule.over.enabled))).map(rule => rule.id));
  if (ids.size === 0) return { kind: 'off' };
  const results = assessment.rules.filter(result => ids.has(result.ruleId)), unavailable = results.filter(result => result.state === 'unavailable').length;
  return results.length > 0 && unavailable === results.length ? { kind: 'unavailable' } : { kind: 'on', unavailable };
}

/** Decorative only: server color and intensity never drive text contrast or row opacity; adjacent text states the result. */
function Swatch({ appearance, label }: { appearance: Appearance; label: string }) {
  if (!appearance || !hexColor.test(appearance.color)) return null;
  const width = `${Math.min(10000, Math.max(0, appearance.intensityBps)) / 100}%`;
  return <span aria-hidden="true" title={label} className="inline-flex shrink-0 items-center gap-1">
    <span data-check-swatch="" className="size-2.5 rounded-full border border-ink/60" style={{ backgroundColor: appearance.color }}/>
    <span className="block h-1.5 w-6 overflow-hidden rounded-full border border-ink/60 bg-canvas"><span className="block h-full" style={{ width, backgroundColor: appearance.color }}/></span>
  </span>;
}

/** Presentational report built only from authoritative server aggregates, never from loaded task flags. `config` must be the configuration the assessment was computed with (the pinned checkpoint config when historical). */
function c(key: string, parameters?: Record<string, string | number>) {
    switch (key) {
      case 'title': return t('genericReports.checksReport.title', parameters);
      case 'scope': return t('genericReports.checksReport.scope', parameters);
      case 'asOf': return t('genericReports.checksReport.asOf', parameters);
      case 'undatedIncluded': return t('genericReports.checksReport.undatedIncluded', parameters);
      case 'disabled': return t('genericReports.checksReport.disabled', parameters);
      case 'off': return t('genericReports.checksReport.off', parameters);
      case 'metric.missingRequiredTasks': return t('genericReports.checksReport.metric.missingRequiredTasks', parameters);
      case 'metric.overdueTasks': return t('genericReports.checksReport.metric.overdueTasks', parameters);
      case 'metric.underplannedGroups': return t('genericReports.checksReport.metric.underplannedGroups', parameters);
      case 'metric.overplannedGroups': return t('genericReports.checksReport.metric.overplannedGroups', parameters);
      case 'metricOff': return t('genericReports.checksReport.metricOff', parameters);
      case 'metricUnavailable': return t('genericReports.checksReport.metricUnavailable', parameters);
      case 'metricPartial': return t('genericReports.checksReport.metricPartial', parameters);
      case 'denominator': return t('genericReports.checksReport.denominator', parameters);
      case 'rules': return t('genericReports.checksReport.rules', parameters);
      case 'col.rule': return t('genericReports.checksReport.col.rule', parameters);
      case 'col.state': return t('genericReports.checksReport.col.state', parameters);
      case 'col.issues': return t('genericReports.checksReport.col.issues', parameters);
      case 'col.actions': return t('genericReports.checksReport.col.actions', parameters);
      case 'unknownRule': return t('genericReports.checksReport.unknownRule', parameters);
      case 'kind.presence': return t('genericReports.checksReport.kind.presence', parameters);
      case 'kind.overdue': return t('genericReports.checksReport.kind.overdue', parameters);
      case 'kind.balance': return t('genericReports.checksReport.kind.balance', parameters);
      case 'state.ok': return t('genericReports.checksReport.state.ok', parameters);
      case 'state.warning': return t('genericReports.checksReport.state.warning', parameters);
      case 'state.unavailable': return t('genericReports.checksReport.state.unavailable', parameters);
      case 'state.disabled': return t('genericReports.checksReport.state.disabled', parameters);
      case 'reason.field_unavailable': return t('genericReports.checksReport.reason.field_unavailable', parameters);
      case 'reason.group_unavailable': return t('genericReports.checksReport.reason.group_unavailable', parameters);
      case 'reason.member_unavailable': return t('genericReports.checksReport.reason.member_unavailable', parameters);
      case 'reason.schedule_unknown': return t('genericReports.checksReport.reason.schedule_unknown', parameters);
      case 'reason.project_dates_missing': return t('genericReports.checksReport.reason.project_dates_missing', parameters);
      case 'reason.project_dates_too_long': return t('genericReports.checksReport.reason.project_dates_too_long', parameters);
      case 'reason.zero_target': return t('genericReports.checksReport.reason.zero_target', parameters);
      case 'reason.incomplete_plan': return t('genericReports.checksReport.reason.incomplete_plan', parameters);
      case 'reason.no_known_plan': return t('genericReports.checksReport.reason.no_known_plan', parameters);
      case 'reason.date_field_unavailable': return t('genericReports.checksReport.reason.date_field_unavailable', parameters);
      case 'reason.disabled': return t('genericReports.checksReport.reason.disabled', parameters);
      case 'ruleIssues': return t('genericReports.checksReport.ruleIssues', parameters);
      case 'undated': return t('genericReports.checksReport.undated', parameters);
      case 'showIssues': return t('genericReports.checksReport.showIssues', parameters);
      case 'showIssuesFor': return t('genericReports.checksReport.showIssuesFor', parameters);
      case 'intensity': return t('genericReports.checksReport.intensity', parameters);
      case 'people': return t('genericReports.checksReport.people', parameters);
      case 'col.person': return t('genericReports.checksReport.col.person', parameters);
      case 'col.eligible': return t('genericReports.checksReport.col.eligible', parameters);
      case 'unassigned': return t('genericReports.checksReport.unassigned', parameters);
      case 'noPeople': return t('genericReports.checksReport.noPeople', parameters);
      case 'peopleScope': return t('genericReports.checksReport.peopleScope', parameters);
      case 'groups': return t('genericReports.checksReport.groups', parameters);
      case 'col.group': return t('genericReports.checksReport.col.group', parameters);
      case 'col.planned': return t('genericReports.checksReport.col.planned', parameters);
      case 'col.target': return t('genericReports.checksReport.col.target', parameters);
      case 'col.notes': return t('genericReports.checksReport.col.notes', parameters);
      case 'direction.under': return t('genericReports.checksReport.direction.under', parameters);
      case 'direction.within': return t('genericReports.checksReport.direction.within', parameters);
      case 'direction.over': return t('genericReports.checksReport.direction.over', parameters);
      case 'basis.computed_capacity': return t('genericReports.checksReport.basis.computed_capacity', parameters);
      case 'basis.configured_manual': return t('genericReports.checksReport.basis.configured_manual', parameters);
      case 'basis.fixed': return t('genericReports.checksReport.basis.fixed', parameters);
      case 'computedCapacity': return t('genericReports.checksReport.computedCapacity', parameters);
      case 'range': return t('genericReports.checksReport.range', parameters);
      case 'mismatch': return t('genericReports.checksReport.mismatch', parameters);
      case 'mismatchUnknown': return t('genericReports.checksReport.mismatchUnknown', parameters);
      case 'allTasksScope': return t('genericReports.checksReport.allTasksScope', parameters);
      case 'coverage': return t('genericReports.checksReport.coverage', parameters);
      case 'history': return t('genericReports.checksReport.history', parameters);
      case 'col.checkpoint': return t('genericReports.checksReport.col.checkpoint', parameters);
      case 'col.capturedAt': return t('genericReports.checksReport.col.capturedAt', parameters);
      case 'col.asOf': return t('genericReports.checksReport.col.asOf', parameters);
      case 'historyEmpty': return t('genericReports.checksReport.historyEmpty', parameters);
      case 'historyCount': return t('genericReports.checksReport.historyCount', parameters);
      case 'historyNeutral': return t('genericReports.checksReport.historyNeutral', parameters);
      case 'historicalBanner': return t('genericReports.checksReport.historicalBanner', parameters);
      case 'historicalBannerUnknown': return t('genericReports.checksReport.historicalBannerUnknown', parameters);
      case 'backToCurrent': return t('genericReports.checksReport.backToCurrent', parameters);
      case 'panelTitle': return t('genericReports.checksReport.panelTitle', parameters);
      case 'refresh': return t('genericReports.checksReport.refresh', parameters);
      case 'configure': return t('genericReports.checksReport.configure', parameters);
      case 'capture': return t('genericReports.checksReport.capture', parameters);
      case 'loading': return t('genericReports.checksReport.loading', parameters);
      case 'loadingCheckpoint': return t('genericReports.checksReport.loadingCheckpoint', parameters);
      case 'previousHistory': return t('genericReports.checksReport.previousHistory', parameters);
      case 'nextHistory': return t('genericReports.checksReport.nextHistory', parameters);
      case 'historyPage': return t('genericReports.checksReport.historyPage', parameters);
      case 'returnCurrent': return t('genericReports.checksReport.returnCurrent', parameters);
      case 'captureName': return t('genericReports.checksReport.captureName', parameters);
      case 'confirmCapture': return t('genericReports.checksReport.confirmCapture', parameters);
      case 'captureHint': return t('genericReports.checksReport.captureHint', parameters);
      case 'retryExact': return t('genericReports.checksReport.retryExact', parameters);
      case 'checkpointMeta': return t('genericReports.checksReport.checkpointMeta', parameters);
      case 'balanceIssues': return t('genericReports.checksReport.balanceIssues', parameters);
      case 'col.unavailable': return t('genericReports.checksReport.col.unavailable', parameters);
      case 'historyRevision': return t('genericReports.checksReport.historyRevision', parameters);
      case 'historyCapturedBars': return t('genericReports.checksReport.historyCapturedBars', parameters);
      default: return t('genericReports.checksReport.unknownRule');
    }
  }

export function PlanningCheckReportView({ assessment, config, historical, checkpoints, historyTotal, onOpenCheckpoint, onCurrent, onIssues, selectedCheckpoint, showHistory = true }: PlanningCheckReportViewProps) {
  useTranslation();
  const ruleOf = (id: string) => config.rules.find(rule => rule.id === id), ruleName = (id: string) => ruleOf(id)?.name ?? c('unknownRule');
  const statuses = new Map(metrics.map(metric => [metric, metricStatus(metric, config, assessment)] as const));
  const countText = (metric: Metric, counts: PlanningCheckCountsDto) => { const status = statuses.get(metric); return !status || status.kind === 'off' ? c('off') : status.kind === 'unavailable' ? dash : String(counts[metric]); };
  const intensity = (appearance: Appearance) => appearance ? c('intensity', { percent: appearance.intensityBps / 100 }) : '';
  /** Headers carry no assessment id; match the immutable evidence identity, so identical captures are equivalent. */
  const selected = historical ? selectedCheckpoint ?? checkpoints.find(point => point.projectId === assessment.projectId && point.sourceVersion === assessment.sourceVersion && point.settingsRevision === assessment.settingsRevision && point.asOf === assessment.asOf) : undefined;
  const { scope, summary } = assessment;
  return <section aria-label={t(historical ? 'genericReports.checksReport.capturedAssessment' : 'genericReports.checksReport.currentAssessment')} className="min-w-0 space-y-3 text-ink">
    {historical ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
      <p role="status" className="text-sm font-medium">{selected ? c('historicalBanner', { name: selected.name, capturedAt: selected.capturedAt, asOf: assessment.asOf }) : c('historicalBannerUnknown', { asOf: assessment.asOf })}</p>
      <Button type="button" onClick={onCurrent}>{c('backToCurrent')}</Button>
    </div> : null}
    <header className="space-y-0.5">
      <h3 className="sr-only">{c('title')}</h3>
      <p className="text-xs text-muted">{c('scope', { tasks: scope.taskCount, linked: scope.excludedLinkedTasks })}</p>
      <p className="text-xs text-muted">{c('asOf', { asOf: assessment.asOf, timezone: assessment.timezone })} · {c('undatedIncluded')}</p>
    </header>
    {config.enabled && assessment.enabled ? null : <p role="status" className="text-xs text-muted">{c('disabled')}</p>}
    {config.enabled && assessment.enabled ? <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{metrics.map(metric => {
      const status = statuses.get(metric), title = t(metric === 'missingRequiredTasks' ? 'genericReports.checksReport.metric.missingRequiredTasks' : metric === 'overdueTasks' ? 'genericReports.checksReport.metric.overdueTasks' : metric === 'underplannedGroups' ? 'genericReports.checksReport.metric.underplannedGroups' : 'genericReports.checksReport.metric.overplannedGroups');
      const note = !status || status.kind === 'off' ? c('metricOff') : status.kind === 'unavailable' ? c('metricUnavailable') : status.unavailable > 0 ? c('metricPartial', { rules: status.unavailable }) : null;
      return <article key={metric} aria-label={title} className="min-w-0 rounded-lg border border-line bg-surface px-3 py-2">
        <h3 title={title} className="truncate text-xs text-muted">{title}</h3>
        <p className="text-xl font-semibold tabular-nums">{countText(metric, summary)}</p>
        {note ? <p className="text-xs text-muted">{note}</p> : null}
      </article>;
    })}</div> : null}
    <p className="text-xs tabular-nums text-muted">{c('denominator', { eligible: summary.eligibleTasks, unavailable: summary.unavailableRules })}</p>
    {assessment.rules.length ? <details className="space-y-1 rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold">{c('rules')} ({assessment.rules.length})</summary>
      <div className="overflow-x-auto"><table className="w-full text-xs">
        <thead><tr>{['col.rule', 'col.state', 'col.issues'].map(key => <th key={key} scope="col" className={head}>{c(key)}</th>)}<th scope="col" className={head}><span className="sr-only">{c('col.actions')}</span></th></tr></thead>
        <tbody>{assessment.rules.map(result => {
          const name = ruleName(result.ruleId), off = result.state === 'disabled' || ruleOf(result.ruleId)?.enabled === false;
          return <tr key={result.ruleId} className="border-t border-line">
            <th scope="row" className={`${cell} text-left font-medium`}><span className="inline-flex min-w-0 items-center gap-2"><Swatch appearance={result.appearance} label={intensity(result.appearance)}/><span className="break-words">{name}</span></span><span className="block font-normal text-muted">{c(`kind.${result.kind}`)}</span></th>
            <td className={cell}>{c(`state.${off ? 'disabled' : result.state}`)}{result.reason && result.reason !== 'disabled' ? <span className="block text-muted">{c(`reason.${result.reason}`)}</span> : null}</td>
            <td className={`${cell} tabular-nums`}>{off ? c('off') : result.state === 'unavailable' ? dash : result.kind === 'balance' ? c('balanceIssues', { groups: result.issueCount, tasks: result.eligibleTasks }) : c('ruleIssues', { issues: result.issueCount, eligible: result.eligibleTasks })}{!off && result.undatedTasks > 0 ? <span className="block text-muted">{c('undated', { count: result.undatedTasks })}</span> : null}</td>
            <td className={`${cell} text-right`}>{!historical && !off && result.state !== 'unavailable' && result.issueCount > 0 ? <Button type="button" aria-label={t('genericReports.checksReport.showIssuesFor', { rule: name })} onClick={() => onIssues(result.ruleId)}>{c('showIssues')}</Button> : null}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </details> : null}
    <section className="space-y-1">
      <h3 className="text-xs font-semibold">{c('people')}</h3>
      {assessment.people.length ? <div className="overflow-x-auto"><table className="w-full text-xs">
        <thead><tr><th scope="col" className={head}>{c('col.person')}</th>{metrics.map(metric => <th key={metric} scope="col" className={head}>{c(`metric.${metric}`)}</th>)}<th scope="col" className={head}>{c('col.eligible')}</th></tr></thead>
        <tbody>{assessment.people.map((person, index) => <tr key={person.membershipId ?? `unassigned-${index}`} className="border-t border-line">
          <th scope="row" className={`${cell} text-left font-medium`}>{person.displayName || c('unassigned')}</th>
          {metrics.map(metric => <td key={metric} className={`${cell} tabular-nums`}>{countText(metric, person.counts)}</td>)}
          <td className={`${cell} tabular-nums`}>{person.counts.eligibleTasks}</td>
        </tr>)}</tbody>
      </table></div> : <p className="text-xs text-muted">{c('noPeople')}</p>}
      <p className="text-xs text-muted">{c('peopleScope')}</p>
    </section>
    {assessment.groups.length ? <section className="space-y-1">
      <h3 className="text-xs font-semibold">{c('groups')}</h3>
      <div className="overflow-x-auto"><table className="w-full text-xs">
        <thead><tr>{['col.group', 'col.state', 'col.planned', 'col.target', 'col.notes'].map(key => <th key={key} scope="col" className={head}>{c(key)}</th>)}</tr></thead>
        <tbody>{assessment.groups.map(group => <tr key={`${group.ruleId}:${group.groupKey}`} className="border-t border-line">
          <th scope="row" className={`${cell} text-left font-medium`}><span className="inline-flex min-w-0 items-center gap-2"><Swatch appearance={group.appearance} label={intensity(group.appearance)}/><span className="break-words">{group.label || dash}</span></span><span className="block font-normal text-muted">{ruleName(group.ruleId)}</span></th>
          <td className={cell}>{c(`state.${group.state}`)}{group.direction && group.state !== 'disabled' ? <span className="block">{c(`direction.${group.direction}`)}</span> : null}{group.reason && group.reason !== 'disabled' ? <span className="block text-muted">{c(`reason.${group.reason}`)}</span> : null}</td>
          <td className={`${cell} tabular-nums`}>{amount(group.planned, group.unit)}</td>
          <td className={`${cell} tabular-nums`}><span className="block">{amount(group.target, group.unit)}</span><span className="block text-muted">{c(`basis.${group.targetBasis}`)}</span>{group.computedAvailableMinutes !== null && group.targetBasis !== 'computed_capacity' ? <span className="block text-muted">{c('computedCapacity', { value: reportNumber(wholeMinutes(group.computedAvailableMinutes), 'minutes', true) })}</span> : null}</td>
          <td className={`${cell} space-y-0.5 text-muted`}>
            {group.range ? <span className="block">{c('range', { from: group.range.from, to: group.range.to })}</span> : null}
            {group.scopeAlignment === 'different_periods' ? <span role="note" className="block font-medium text-accent-strong">{group.cohortRange && group.range ? c('mismatch', { cohortFrom: group.cohortRange.from, cohortTo: group.cohortRange.to, from: group.range.from, to: group.range.to }) : c('mismatchUnknown')}</span> : null}
            {group.scopeAlignment === 'all_tasks' && group.range ? <span className="block">{c('allTasksScope')}</span> : null}
            <span className="block">{c('coverage', { filled: group.coverage.filled, tasks: group.coverage.tasks })}</span>
            {group.undatedTasks > 0 ? <span className="block">{c('undated', { count: group.undatedTasks })}</span> : null}
          </td>
        </tr>)}</tbody>
      </table></div>
    </section> : null}
    {showHistory ? <PlanningCheckHistory checkpoints={checkpoints} historyTotal={historyTotal} selectedId={selected?.id ?? null} onOpenCheckpoint={onOpenCheckpoint}/> : null}
  </section>;
}

function PlanningCheckHistory({ checkpoints, historyTotal, selectedId, onOpenCheckpoint }: Pick<PlanningCheckReportViewProps, 'checkpoints' | 'historyTotal' | 'onOpenCheckpoint'> & { selectedId: string | null }) {
  useTranslation();
  const shown = checkpoints.slice(0, historyPage);
  const maximum = Math.max(1, ...shown.flatMap(point => metrics.map(metric => point.summary[metric])));
  const seriesTone = (metric: Metric) => metric === 'missingRequiredTasks' ? 'bg-amber-500' : metric === 'overdueTasks' ? 'bg-rose-500' : metric === 'underplannedGroups' ? 'bg-cyan-600' : 'bg-accent';
  return (
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold">{c('history', { total: historyTotal })}</summary>
      {shown.length ? <div className="mt-2 overflow-x-auto"><table className="w-full text-xs">
        <thead><tr>{['col.checkpoint', 'col.capturedAt', 'col.asOf', 'historyRevision', 'col.eligible', 'col.unavailable'].map(key => <th key={key} scope="col" className={head}>{c(key)}</th>)}{metrics.map(metric => <th key={metric} scope="col" className={head}>{c(`metric.${metric}`)}</th>)}</tr></thead>
        <tbody>{shown.map(point => <tr key={point.id} aria-current={selectedId === point.id ? 'true' : undefined} className="border-t border-line">
          <th scope="row" className={`${cell} text-left`}><Button type="button" onClick={() => onOpenCheckpoint(point.id)}>{point.name}</Button></th>
          <td className={cell}><time dateTime={point.capturedAt}>{point.capturedAt}</time></td>
          <td className={cell}><time dateTime={point.asOf}>{point.asOf}</time></td><td className={cell}>{point.settingsRevision}</td><td className={cell}>{point.summary.eligibleTasks}</td><td className={cell}>{point.summary.unavailableRules}</td>
          {metrics.map(metric => <td key={metric} className={`${cell} tabular-nums`}>{point.summary[metric]}<span aria-hidden="true" className="mt-1 block h-1 rounded-full bg-canvas"><span className={`block h-full rounded-full ${seriesTone(metric)}`} style={{ width: `${point.summary[metric] * 100 / maximum}%` }}/></span></td>)}
        </tr>)}</tbody>
      </table></div> : <p className="mt-2 text-xs text-muted">{c('historyEmpty')}</p>}
      {historyTotal > shown.length ? <p className="mt-1 text-xs text-muted">{c('historyCount', { shown: shown.length, total: historyTotal })}</p> : null}
      <p className="mt-1 text-xs text-muted">{c('historyNeutral')}</p>
    </details>
  );
}
