import { useState } from 'react';
import type { GenericReportConfig, MembershipDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { genericReportConfigSchema } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ReportSelect } from './ReportConfigEditor';

/** Read-only overrides are sent to the existing authoritative aggregate endpoint, never applied to a loaded page. */
export function ReportQuickFilters({ config, originalConfig, members, fields, disabled, onApply, onReset }: { config: GenericReportConfig; originalConfig: GenericReportConfig; members: readonly MembershipDto[]; fields: readonly TaskFieldDefinitionDto[]; disabled: boolean; onApply: (config: GenericReportConfig) => void; onReset: () => void }) {
  const { t } = useTranslation();
  const [person, setPerson] = useState(config.filters.assignee.kind === 'member' ? config.filters.assignee.membershipId : config.filters.assignee.kind);
  const [dateSource, setDateSource] = useState(config.filters.dateRange?.source.kind === 'field' ? config.filters.dateRange.source.fieldId : config.filters.dateRange ? 'due_date' : 'all');
  const [from, setFrom] = useState(config.filters.dateRange?.from ?? ''), [to, setTo] = useState(config.filters.dateRange?.to ?? '');
  const [alignCapacity,setAlignCapacity] = useState(false);
  const [invalid, setInvalid] = useState(false);
  return <form aria-label={t('genericReports.filters')} className="flex flex-wrap items-end gap-2 rounded-lg bg-surface py-2" onSubmit={event => {
    event.preventDefault();
    const next: GenericReportConfig = { ...config, filters: { ...config.filters, assignee: person === 'all' ? {kind:'all'} : person === 'unassigned' ? {kind:'unassigned'} : {kind:'member',membershipId:person}, dateRange: dateSource === 'all' ? null : { source: dateSource === 'due_date' ? {kind:'due_date'} : {kind:'field',fieldId:dateSource}, from, to } } };
    if(alignCapacity && dateSource !== 'all' && person !== 'unassigned' && config.capacity) next.capacity={startDate:from,endDate:to,people:person==='all'?{kind:'all_active'}:{kind:'selected',membershipIds:[person]}};
    const parsed = genericReportConfigSchema.safeParse(next); setInvalid(!parsed.success); if(parsed.success) onApply(parsed.data);
  }}>
    <ReportSelect label={t('genericReports.quickPeople')} value={person} disabled={disabled} onChange={setPerson}><option value="all">{t('genericReports.everyone')}</option><option value="unassigned">{t('genericReports.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</ReportSelect>
    <ReportSelect label={t('genericReports.quickDateSource')} value={dateSource} disabled={disabled} onChange={setDateSource}><option value="all">{t('genericReports.allTime')}</option><option value="due_date">{t('genericReports.dueDate')}</option>{fields.filter(field=>field.type==='date'&&field.archivedAt===null).map(field=><option key={field.id} value={field.id}>{field.name}</option>)}</ReportSelect>
    {dateSource !== 'all' ? <><label className="grid w-40 gap-1 text-xs text-muted">{t('genericReports.from')}<TextInput type="date" value={from} disabled={disabled} onChange={e=>setFrom(e.target.value)}/></label><label className="grid w-40 gap-1 text-xs text-muted">{t('genericReports.to')}<TextInput type="date" value={to} disabled={disabled} onChange={e=>setTo(e.target.value)}/></label></> : null}
    {config.capacity && dateSource !== 'all' && person !== 'unassigned' ? <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={alignCapacity} disabled={disabled} onChange={e=>setAlignCapacity(e.target.checked)}/>{t('genericReports.alignCapacity')}</label> : null}
    <Button type="submit" size="sm" disabled={disabled}>{t('genericReports.applyFilters')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={()=>{const original=originalConfig.filters.assignee;setPerson(original.kind==='member'?original.membershipId:original.kind);setDateSource(originalConfig.filters.dateRange?.source.kind==='field'?originalConfig.filters.dateRange.source.fieldId:originalConfig.filters.dateRange?'due_date':'all');setFrom(originalConfig.filters.dateRange?.from??'');setTo(originalConfig.filters.dateRange?.to??'');setInvalid(false);setAlignCapacity(false);onReset();}}>{t('genericReports.resetFilters')}</Button>
    {invalid ? <p role="alert" className="basis-full text-xs text-danger">{t('genericReports.quickInvalid')}</p> : null}
    {dateSource !== 'all' ? <p className="sr-only">{t('genericReports.quickDateHint')}</p> : null}
  </form>;
}
