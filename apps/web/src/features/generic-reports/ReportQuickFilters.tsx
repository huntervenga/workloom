import { useState } from 'react';
import type { GenericReportConfig, MembershipDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { genericReportConfigSchema } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ReportSelect } from './ReportConfigEditor';
import { DEFAULT_REPORT_CALENDAR, reportCalendarRange, type ReportCalendarContext } from './reportCalendar';

/** Calendar presets are transient report filters, never native planning periods or saved definition writes. */
export function reportPeriodConfig(config: GenericReportConfig, preset: 'week' | 'month' | 'all', calendar: ReportCalendarContext = DEFAULT_REPORT_CALENDAR, clock: Date = new Date()): GenericReportConfig {
  const {capacity, ...withoutCapacity} = config;
  void capacity;
  if (preset === 'all') return { ...withoutCapacity, filters: { ...config.filters, dateRange: null } };
  const {from, to} = reportCalendarRange(preset, calendar, clock), assignee = config.filters.assignee;
  return { ...withoutCapacity, filters: { ...config.filters, dateRange: { source: config.filters.dateRange?.source ?? {kind:'due_date'}, from, to } }, ...(assignee.kind === 'unassigned' ? {} : { capacity: {startDate: from, endDate: to, people: assignee.kind === 'member' ? {kind:'selected' as const, membershipIds:[assignee.membershipId]} : {kind:'all_active' as const}} }) };
}

/** Add capacity only for an explicit task-date interval and explicit person scope. */
export function reportScopeCapacityConfig(config: GenericReportConfig, calendar: ReportCalendarContext = DEFAULT_REPORT_CALENDAR, clock: Date = new Date()): GenericReportConfig {
  const date = config.filters.dateRange, person = config.filters.assignee;
  if (!date) return reportPeriodConfig(config, 'week', calendar, clock);
  if (person.kind === 'unassigned') return config;
  return { ...config, capacity: { startDate: date.from, endDate: date.to, people: person.kind === 'member' ? { kind: 'selected', membershipIds: [person.membershipId] } : { kind: 'all_active' } } };
}

/** Read-only overrides are sent to the existing authoritative aggregate endpoint, never applied to a loaded page. */
export function ReportQuickFilters({ config, originalConfig, members, fields, disabled, calendar = DEFAULT_REPORT_CALENDAR, projectDateRange, onApply, onReset }: { config: GenericReportConfig; originalConfig: GenericReportConfig; members: readonly MembershipDto[]; fields: readonly TaskFieldDefinitionDto[]; disabled: boolean; calendar?: ReportCalendarContext; projectDateRange?: { from: string; to: string } | null; onApply: (config: GenericReportConfig) => void; onReset: () => void }) {
  const { t } = useTranslation();
  const [person, setPerson] = useState(config.filters.assignee.kind === 'member' ? config.filters.assignee.membershipId : config.filters.assignee.kind);
  const [dateSource, setDateSource] = useState(config.filters.dateRange?.source.kind === 'field' ? config.filters.dateRange.source.fieldId : config.filters.dateRange ? 'due_date' : 'all');
  const [from, setFrom] = useState(config.filters.dateRange?.from ?? ''), [to, setTo] = useState(config.filters.dateRange?.to ?? '');
  const [alignCapacity,setAlignCapacity] = useState(false);
  const [invalid, setInvalid] = useState(false);
  return <form aria-label={t('genericReports.filters')} className="flex flex-wrap items-end gap-2 rounded-lg bg-surface py-2" onSubmit={event => {
    event.preventDefault();
    const next: GenericReportConfig = { ...config, filters: { ...config.filters, assignee: person === 'all' ? {kind:'all'} : person === 'unassigned' ? {kind:'unassigned'} : {kind:'member',membershipId:person}, dateRange: dateSource === 'all' ? null : { source: dateSource === 'due_date' ? {kind:'due_date'} : {kind:'field',fieldId:dateSource}, from, to } } };
    if(alignCapacity && dateSource !== 'all' && person !== 'unassigned') next.capacity={startDate:from,endDate:to,people:person==='all'?{kind:'all_active'}:{kind:'selected',membershipIds:[person]}};
    const parsed = genericReportConfigSchema.safeParse(next); setInvalid(!parsed.success); if(parsed.success) onApply(parsed.data);
  }}>
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('genericReports.rangePreset')}>{(['week','month','all'] as const).map(preset=><Button key={preset} type="button" size="sm" variant="ghost" disabled={disabled} onClick={()=>{const next=reportPeriodConfig(config,preset,calendar);setDateSource(next.filters.dateRange?.source.kind==='field'?next.filters.dateRange.source.fieldId:next.filters.dateRange?'due_date':'all');setFrom(next.filters.dateRange?.from??'');setTo(next.filters.dateRange?.to??'');setInvalid(false);onApply(next);}}>{t(preset==='week'?'genericReports.weekPreset':preset==='month'?'genericReports.monthPreset':'genericReports.quickAllTime')}</Button>)}{projectDateRange ? <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { const dateRange = { source: config.filters.dateRange?.source ?? { kind: 'due_date' as const }, ...projectDateRange }; const next = reportScopeCapacityConfig({ ...config, filters: { ...config.filters, dateRange } }, calendar); setDateSource(dateRange.source.kind === 'field' ? dateRange.source.fieldId : 'due_date'); setFrom(dateRange.from); setTo(dateRange.to); setInvalid(false); onApply(next); }}>{t('genericReports.useProjectDates')}</Button> : null}</div>
    <ReportSelect label={t('genericReports.quickPeople')} value={person} disabled={disabled} onChange={setPerson}><option value="all">{t('genericReports.everyone')}</option><option value="unassigned">{t('genericReports.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</ReportSelect>
    <ReportSelect label={t('genericReports.quickDateSource')} value={dateSource} disabled={disabled} onChange={setDateSource}><option value="all">{t('genericReports.allTime')}</option><option value="due_date">{t('genericReports.dueDate')}</option>{fields.filter(field=>field.type==='date'&&field.archivedAt===null).map(field=><option key={field.id} value={field.id}>{field.name}</option>)}</ReportSelect>
    {dateSource !== 'all' ? <><label className="grid w-40 gap-1 text-xs text-muted">{t('genericReports.from')}<TextInput type="date" value={from} disabled={disabled} onChange={e=>setFrom(e.target.value)}/></label><label className="grid w-40 gap-1 text-xs text-muted">{t('genericReports.to')}<TextInput type="date" value={to} disabled={disabled} onChange={e=>setTo(e.target.value)}/></label></> : null}
    {dateSource !== 'all' && person !== 'unassigned' ? <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={alignCapacity} disabled={disabled} onChange={e=>setAlignCapacity(e.target.checked)}/>{t('genericReports.alignCapacity')}</label> : null}
    <Button type="submit" size="sm" disabled={disabled}>{t('genericReports.applyFilters')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={()=>{const original=originalConfig.filters.assignee;setPerson(original.kind==='member'?original.membershipId:original.kind);setDateSource(originalConfig.filters.dateRange?.source.kind==='field'?originalConfig.filters.dateRange.source.fieldId:originalConfig.filters.dateRange?'due_date':'all');setFrom(originalConfig.filters.dateRange?.from??'');setTo(originalConfig.filters.dateRange?.to??'');setInvalid(false);setAlignCapacity(false);onReset();}}>{t('genericReports.resetFilters')}</Button>
    {invalid ? <p role="alert" className="basis-full text-xs text-danger">{t('genericReports.quickInvalid')}</p> : null}
    {dateSource !== 'all' ? <p className="sr-only">{t('genericReports.quickDateHint')}</p> : null}
  </form>;
}
