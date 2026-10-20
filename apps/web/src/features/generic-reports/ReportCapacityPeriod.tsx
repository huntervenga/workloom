import { useLayoutEffect, useRef, useState } from 'react';
import { Button, TextInput } from '@workloom/ui';
import { Info, Pencil } from 'lucide-react';
import type { GenericReportConfig } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { ReportSelect } from './ReportConfigEditor';
import { validCapacityRange, type CapacityDateRange, type ReportCapacityChoice, type ReportCapacityView } from './reportCapacityView';

/** Transient, visible availability source. Never changes a task-date filter or saved report. */
export function ReportCapacityPeriod({ view, baseConfig, disabled, onChange }: { view: ReportCapacityView; baseConfig: GenericReportConfig; disabled: boolean; onChange: (choice: ReportCapacityChoice | null) => void }) {
 const { t } = useTranslation();
 const [customOpen, setCustomOpen] = useState(false), [from, setFrom] = useState(''), [to, setTo] = useState(''), [invalid, setInvalid] = useState(false);
 const errorRef = useRef<HTMLParagraphElement>(null);
 useLayoutEffect(() => { if (invalid) errorRef.current?.focus(); }, [invalid]);
 const sourceLabels = { saved: t('genericReports.capacityPeriod.reportDates'), project_dates: t('genericReports.tableAggregates.projectDates'), task_dates: t('genericReports.capacityPeriod.taskDates'), custom: t('genericReports.customRange'), none: t('genericReports.capacityPeriod.off') };
 const reasons = { no_period: t('genericReports.capacityPeriod.noPeriod'), project_dates_missing: t('genericReports.tableAggregates.projectDatesMissing'), task_dates_missing: t('genericReports.capacityPeriod.noTaskDates'), invalid_range: t('genericReports.tableAggregates.invalidSummaryRange'), unassigned: t('genericReports.dashboard.capacityUnassigned') };
 const openCustom = () => { setFrom(view.range?.from ?? ''); setTo(view.range?.to ?? ''); setCustomOpen(true); setInvalid(false); };
 const select = (source: string) => {
  if (disabled) return;
  setInvalid(false);
  if (source === 'custom') { openCustom(); return; }
  setCustomOpen(false);
  if (source === 'saved') onChange(null);
  else onChange({ kind: source === 'project_dates' ? 'project_dates' : source === 'task_dates' ? 'task_dates' : 'none' });
 };
 const apply = () => { const range: CapacityDateRange = { from, to }; if (disabled) return; if (!validCapacityRange(range)) { setInvalid(true); return; } setInvalid(false); setCustomOpen(false); onChange({ kind: 'custom', ...range }); };
 const scopeLabel = `${t('genericReports.capacityPeriod.title')} · ${t('genericReports.hierarchy')}`;
 return <section aria-label={t('genericReports.capacityPeriod.title')} className={`min-w-0 space-y-2 ${customOpen ? 'w-full basis-full' : 'ml-auto max-w-full'}`}>
  <div className="flex items-end gap-1"><div className="w-44 min-w-0">
  <ReportSelect label={t('genericReports.capacityPeriod.title')} value={customOpen ? 'custom' : view.source} disabled={disabled} onChange={select}>
   {baseConfig.capacity ? <option value="saved">{sourceLabels.saved}</option> : null}<option value="project_dates">{sourceLabels.project_dates}</option><option value="task_dates">{sourceLabels.task_dates}</option><option value="custom">{sourceLabels.custom}</option><option value="none">{sourceLabels.none}</option>
  </ReportSelect></div><details className="relative shrink-0"><summary aria-label={scopeLabel} title={scopeLabel} className="flex size-8 cursor-pointer list-none items-center justify-center rounded text-muted hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"><Info size={15} aria-hidden="true"/></summary><div className="absolute right-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border border-line bg-surface p-3 text-xs text-muted shadow-lg"><p data-report-capacity-period="">{view.range ? t('genericReports.capacityPeriod.current', { from: view.range.from, to: view.range.to, source: sourceLabels[view.source] }) : view.reason ? reasons[view.reason] : t('genericReports.capacityPeriod.disabled')}</p><p>{baseConfig.filters.dateRange ? t('genericReports.capacityPeriod.taskScopeDates', { from: baseConfig.filters.dateRange.from, to: baseConfig.filters.dateRange.to }) : t('genericReports.capacityPeriod.taskScopeAll')}</p></div></details>
  {view.source === 'custom' && !customOpen ? <button type="button" aria-label={t('genericReports.capacityPeriod.edit')} title={t('genericReports.capacityPeriod.edit')} disabled={disabled} onClick={openCustom} className="flex size-8 shrink-0 items-center justify-center rounded text-muted hover:bg-surface disabled:opacity-50"><Pencil size={14} aria-hidden="true"/></button> : null}</div>
  {customOpen ? <div className="flex flex-wrap items-end gap-2"><label className="grid w-40 gap-1 text-xs text-muted">{t('genericReports.from')}<TextInput type="date" value={from} disabled={disabled} onChange={event => { setFrom(event.target.value); setInvalid(false); }}/></label><label className="grid w-40 gap-1 text-xs text-muted">{t('genericReports.to')}<TextInput type="date" value={to} disabled={disabled} onChange={event => { setTo(event.target.value); setInvalid(false); }}/></label><Button type="button" size="sm" disabled={disabled} onClick={apply}>{t('genericReports.capacityPeriod.apply')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setCustomOpen(false); setInvalid(false); }}>{t('common.cancel')}</Button></div> : null}
  {invalid ? <p ref={errorRef} role="alert" tabIndex={-1} className="text-xs text-danger-line">{t('genericReports.tableAggregates.invalidSummaryRange')}</p> : null}
 </section>;
}
