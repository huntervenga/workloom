import { RecordedWorkLabel } from '../../shared/RecordedWorkLabel';
import type { MembershipDto, PlanBaselineDto, PlanningPeriodDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto, WeeklyPlanFactSummaryDto } from '@workloom/contracts';
import { Badge, Button, StateCard, inputClassName } from '@workloom/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table';
import { PlanFactChart } from './PlanFactChart';
import { useReportRowsQuery, useReportRunQuery, type PlanningCommands } from './queries';

export interface ReportSelection { baselineId: string; knownOnly: boolean; membershipIds: string[] }

interface Props {
  actorId: string;
  workspaceId: string;
  period: PlanningPeriodDto;
  baselines: readonly PlanBaselineDto[];
  runs: readonly WeeklyPlanFactReportRunDto[];
  members: readonly MembershipDto[];
  runId: string;
  selection: ReportSelection | undefined;
  onSelectionChange: (selection: ReportSelection) => void;
  mutation: PlanningCommands['createReport'];
  onSelectRun: (runId: string, periodId: string) => void;
}

export function WeeklyReport(props: Props) {
  const id = useId();
  const { period, mutation } = props;
  const fallback = period.projectBaselineId ?? props.baselines.find((baseline) => baseline.scope === 'project')?.id ?? props.baselines[0]?.id ?? '';
  const chosen = props.selection ?? { baselineId: fallback, knownOnly: false, membershipIds: [] };
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const shown = held?.input ?? { baselineId: chosen.baselineId, knownEstimatesOnly: chosen.knownOnly, membershipIds: chosen.membershipIds };
  const selectedBaseline = props.baselines.find((baseline) => baseline.id === shown.baselineId);
  const personalMember = selectedBaseline?.scope === 'self' ? selectedBaseline.membershipId : null;
  const setChosen = (update: Partial<ReportSelection>) => props.onSelectionChange({ ...chosen, ...update });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.pendingCommand) return;
    if (mutation.uncertain) { mutation.retryUncertain({ onSuccess: (run) => props.onSelectRun(run.id, run.periodId) }); return; }
    if (!chosen.baselineId) return;
    mutation.mutate({ periodId: period.id, input: { baselineId: chosen.baselineId, knownEstimatesOnly: chosen.knownOnly, membershipIds: chosen.membershipIds } }, { onSuccess: (run) => props.onSelectRun(run.id, run.periodId) });
  };
  return (
    <section aria-label="Недельный отчёт" className="space-y-5">
      <div className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div><h2 className="text-lg font-semibold">План и факт</h2><p className="mt-1 text-sm leading-relaxed text-muted">Каждый расчёт закрепляет исходный план и внесённые версии факта. Новые записи не переписывают уже открытый отчёт.</p></div>
        {props.baselines.length === 0 && held === null ? <p className="text-sm text-muted">Сначала зафиксируйте личный план или план проекта, чтобы рассчитать сравнение.</p> : <form className="space-y-4" onSubmit={submit}>
          <fieldset disabled={held !== null} className="min-w-0 space-y-4">
            <div className="space-y-1.5"><label htmlFor={`${id}-baseline`} className="text-sm font-medium">Исходный снимок плана</label><select id={`${id}-baseline`} className={inputClassName()} value={shown.baselineId} onChange={(event) => { const baseline = props.baselines.find((item) => item.id === event.target.value); setChosen({ baselineId: event.target.value, membershipIds: baseline?.scope === 'self' ? [] : chosen.membershipIds }); }}><option value="">Выберите снимок</option>{props.baselines.map((baseline) => <option key={baseline.id} value={baseline.id}>{baseline.scope === 'project' ? 'План проекта' : `Личный план: ${props.members.find((member) => member.id === baseline.membershipId)?.displayName ?? 'участник'}`} · {dateTime(baseline.frozenAt)}</option>)}{shown.baselineId && !props.baselines.some((baseline) => baseline.id === shown.baselineId) ? <option value={shown.baselineId}>Отправленный снимок другого периода</option> : null}</select></div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={shown.knownEstimatesOnly} onChange={(event) => setChosen({ knownOnly: event.target.checked })} /><span>Сравнить только известные личные планы<span className="mt-1 block text-xs text-muted">Это отдельная выборка; она не показывает полноту всего плана.</span></span></label>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2"><legend className="mb-2 text-sm font-medium">{personalMember ? 'Люди в личном снимке' : 'Люди в отчёте · ничего не выбрано — все доступные'}</legend>{personalMember ? <p className="text-sm text-muted">Только {props.members.find((member) => member.id === personalMember)?.displayName ?? 'участник этого личного снимка'}. Личный снимок не включает планы коллег.</p> : props.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shown.membershipIds.includes(member.id)} onChange={(event) => setChosen({ membershipIds: event.target.checked ? [...chosen.membershipIds, member.id] : chosen.membershipIds.filter((value) => value !== member.id) })} />{member.displayName}</label>)}</fieldset>
          </fieldset>
          <SaveFeedback subject="report" error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} />
          <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || !shown.baselineId}>{mutation.pendingCommand ? 'Рассчитываем…' : mutation.uncertain ? 'Повторить отправку' : 'Рассчитать новый отчёт'}</Button>
        </form>}
        {props.runs.length > 0 ? <div className="space-y-1.5 border-t border-line pt-4"><label htmlFor={`${id}-run`} className="text-sm font-medium">Сохранённый расчёт</label><select id={`${id}-run`} className={inputClassName()} value={props.runId} onChange={(event) => props.onSelectRun(event.target.value, period.id)}><option value="">Выберите расчёт</option>{props.runs.map((run) => <option key={run.id} value={run.id}>{dateTime(run.createdAt)} · {run.knownEstimatesOnly ? 'только известные планы' : 'весь выбранный состав'}</option>)}</select></div> : null}
      </div>
      {props.runId ? <PinnedReport actorId={props.actorId} workspaceId={props.workspaceId} projectId={period.projectId} periodId={period.id} runId={props.runId} /> : null}
    </section>
  );
}

function PinnedReport({ actorId, workspaceId, projectId, periodId, runId }: { actorId: string; workspaceId: string; projectId: string; periodId: string; runId: string }) {
  const run = useReportRunQuery(actorId, workspaceId, runId);
  const rows = useReportRowsQuery(actorId, workspaceId, runId);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (run.isPending) return <p role="status" className="text-sm text-muted">Загрузка закреплённого отчёта…</p>;
  if (run.isError) return <QueryErrorState error={run.error} subject="report" headingLevel={3} retrying={run.isFetching} onRetry={() => void run.refetch()} />;
  if (isAccessDenied(rows.error)) return <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} />;
  if (run.data.projectId !== projectId || run.data.periodId !== periodId) return <StateCard headingLevel={3} title="Этот расчёт относится к другому периоду" description="Выберите сохранённый расчёт для открытой недели." />;
  const report = run.data;
  const originalPeople = report.byPerson.filter((person) => person.summary.baselineCompleteness.totalItemCount > 0);
  return (
    <div className="space-y-5">
      <section aria-label="Закреплённый расчёт" className="space-y-3 rounded-xl border border-line bg-canvas p-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Закреплённый расчёт</h3><Badge tone="muted">Версии сохранены</Badge>{report.knownEstimatesOnly ? <Badge tone="muted">Только известные планы</Badge> : null}</div>
        <p className="text-xs leading-relaxed text-muted">Рассчитан {dateTime(report.createdAt)}. Факт учтён по {dateTime(report.factCutoffAt)}. Последующие правки появятся только в новом расчёте.</p>
        <p className="text-xs text-muted">Выбрано исходных строк: {report.cohort.selectedItemCount} из {report.cohort.originalItemCount}. Данные относятся к доступному составу этого снимка.</p>
        <Summary summary={report.summary} />
      </section>
      <PlanFactChart title="Исходный план и факт по людям" items={originalPeople.map((person) => ({ id: person.membershipId, label: `${person.memberName}${!person.summary.baselineCompleteness.complete || !person.summary.factCoverage.complete ? ' · данные неполные' : ''}`, planMinutes: person.summary.baselineCompleteness.knownItemCount === 0 ? null : person.summary.knownPlannedMinutes, factMinutes: person.summary.factCoverage.recordedItemCount === 0 ? null : person.summary.actualMinutes }))} />
      {originalPeople.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">В исходном плане нет личных обязательств для сравнения. Добавленная и внеплановая работа остаётся в итогах и детализации.</p> : null}
      <p className="text-xs leading-relaxed text-muted">Полосы используют серверные итоги исходного состава. При неполных данных показана только известная часть. Добавленная и внеплановая работа указана отдельно в итогах и детализации.</p>
      {rows.isPending ? <p role="status" className="text-sm text-muted">Загрузка детализации расчёта…</p> : rows.isError && !rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} /> : <>
        <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">Детализация закреплённого плана и факта</caption><thead className="border-b border-line bg-canvas text-xs text-muted"><tr><th className="px-4 py-3">Работа и человек</th><th className="px-3 py-3">Личный план</th><th className="px-3 py-3">Факт</th><th className="px-3 py-3">Разница</th><th className="px-3 py-3">Состав расчёта</th></tr></thead><tbody>{rows.data?.pages.flatMap((page) => page.items).map((row) => <ReportRow key={row.id} row={row} expanded={expanded === row.id} onExpand={() => setExpanded((before) => before === row.id ? null : row.id)} />)}</tbody></table>
          {report.rowCount === 0 ? <p className="p-4 text-sm text-muted">В выбранном составе нет строк для сравнения.</p> : null}
        </div>
        <p className="text-xs text-muted">Все итоги выше рассчитаны сервером и не зависят от числа загруженных строк.</p>
        {rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetchingNextPage} onRetry={() => void rows.fetchNextPage()} /> : null}
        {rows.hasNextPage ? <Button disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>Загрузить ещё строки расчёта</Button> : null}
      </>}
    </div>
  );
}

function Summary({ summary }: { summary: WeeklyPlanFactSummaryDto }) {
  return <>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Metric label="Известный личный план" value={formatEstimate(summary.knownPlannedMinutes)} hint={`Заполнено ${summary.baselineCompleteness.knownItemCount} из ${summary.baselineCompleteness.totalItemCount}`} /><Metric label="Внесённый факт исходного плана" value={formatEstimate(summary.actualMinutes)} hint={`Факт внесён по ${summary.factCoverage.recordedItemCount} из ${summary.factCoverage.totalItemCount}`} /><Metric label="Разница исходного плана" value={summary.totalVarianceMinutes === null ? 'Недостаточно данных' : signedMinutes(summary.totalVarianceMinutes)} hint={summary.totalVariancePercent === null ? 'Процент недоступен при неполных данных или нулевом плане' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(summary.totalVariancePercent)}%`} /></dl>
    <p className="text-xs leading-relaxed text-muted">Добавленный объём: {formatEstimate(summary.addedActualMinutes)} · вне исходного плана: {formatEstimate(summary.unplannedActualMinutes)} · весь внесённый факт: {formatEstimate(summary.totalActualMinutes)}. Отсутствие записи не считается подтверждённым нулём.</p>
  </>;
}
function Metric({ label, value, hint }: { label: string; value: string; hint: string }) { return <div className="rounded-lg border border-line bg-surface p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-lg font-semibold [overflow-wrap:anywhere] text-ink">{value}</dd><p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p></div>; }
function ReportRow({ row, expanded, onExpand }: { row: WeeklyPlanFactRowDto; expanded: boolean; onExpand: () => void }) {
  return <><tr className="border-b border-line"><td className="max-w-xs px-4 py-3"><p className="font-medium [overflow-wrap:anywhere]">{row.title}</p><p className="mt-1 text-xs text-muted">{row.memberName} · {row.scope === 'original' ? 'Исходный план' : row.scope === 'added_scope' ? 'Добавленный объём' : 'Вне исходного плана'}</p></td><td className="px-3 py-3 tabular-nums">{row.plannedMinutes === null ? 'Не задан' : formatEstimate(row.plannedMinutes)}</td><td className="px-3 py-3 tabular-nums">{row.factRecorded ? formatEstimate(row.actualMinutes) : 'Не внесено'}</td><td className="px-3 py-3 tabular-nums">{row.varianceMinutes === null ? '—' : signedMinutes(row.varianceMinutes)}</td><td className="px-3 py-3"><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onExpand}>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}Раскрыть расчёт</Button></td></tr>{expanded ? <tr className="border-b border-line bg-canvas"><td colSpan={5} className="space-y-2 px-4 py-4"><p className="text-xs text-muted">Общая исходная оценка задачи: {row.packageEstimateMinutes === null ? 'неизвестна' : formatEstimate(row.packageEstimateMinutes)}. Личный недельный план сравнивается отдельно.</p>{row.workLogs.length === 0 ? <p className="text-sm text-muted">В закреплённом расчёте нет записей факта этой строки.</p> : <ul className="space-y-2">{row.workLogs.map((log) => <li key={log.revisionId} className="text-sm"><Badge tone="muted"><RecordedWorkLabel log={log}/></Badge> {formatEstimate(log.minutes)} · версия {log.revision}{log.state === 'void' ? ' · отменена' : ''}<span className="block text-xs text-muted">{dateTime(log.recordedAt)}{log.reason ? ` · ${log.reason}` : ''}</span></li>)}</ul>}</td></tr> : null}</>;
}
function signedMinutes(minutes: number): string { return `${minutes > 0 ? '+' : minutes < 0 ? '−' : ''}${formatEstimate(Math.abs(minutes))}`; }
export function dateTime(value: string): string { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
