import type { GenericReportConfig, MembershipDto, TagDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { Children, isValidElement, useState, type ReactNode } from 'react';
import { ChoicePicker, type ChoiceOption } from '../../shared/ChoicePicker';
import { useTranslation } from '../../i18n';

/** JSX options remain a compact declaration; only the established custom picker reaches the DOM. */
function choiceOptions(children: ReactNode): ChoiceOption[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string; children?: ReactNode; disabled?: boolean }>(child)) return [];
    if (child.type === 'option') return [{ value: child.props.value ?? '', label: String(child.props.children ?? ''), disabled: child.props.disabled }];
    return choiceOptions(child.props.children);
  });
}
export function ReportSelect({ label, value, onChange, children, disabled = false }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode; disabled?: boolean }) {
  return <label className="grid min-w-0 gap-1 text-xs text-muted"><span>{label}</span><ChoicePicker compact label={label} value={value} options={choiceOptions(children)} onValueChange={onChange} disabled={disabled}/></label>;
}
export function calendarRange(preset: 'week' | 'month', today = new Date()): { from: string; to: string } {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (preset === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  else start.setDate(1);
  const end = new Date(start);
  if (preset === 'week') end.setDate(end.getDate() + 6); else { end.setMonth(end.getMonth() + 1); end.setDate(0); }
  const date = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return { from: date(start), to: date(end) };
}
export function emptyReportConfig(projectId: string): GenericReportConfig {
  return { projectId, hierarchy: 'all_tasks', measures: [{ key: 'tasks', operation: 'count_tasks' }], comparison: null, groupBy: { kind: 'none' }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } };
}
export function ReportConfigEditor({ config, onChange, fields, members, tags, disabled, measuresOnly = false }: { config: GenericReportConfig; onChange: (config: GenericReportConfig) => void; fields: readonly TaskFieldDefinitionDto[]; members: readonly MembershipDto[]; tags: readonly TagDto[]; disabled: boolean; measuresOnly?: boolean }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState('custom');
  const active = fields.filter(field => field.archivedAt === null);
  const numeric = active.filter(field => field.type === 'number' || field.type === 'duration');
  const durations = active.filter(field => field.type === 'duration');
  const patchFilters = (part: Partial<GenericReportConfig['filters']>) => onChange({ ...config, filters: { ...config.filters, ...part } });
  const options = (catalog: readonly TaskFieldDefinitionDto[], selected: string) => <><option value="">{t('genericReports.chooseField')}</option>{selected && !catalog.some(field => field.id === selected) ? <option value={selected}>{t('genericReports.unavailableField')}</option> : null}{catalog.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</>;
  return <fieldset disabled={disabled} className="min-w-0 space-y-4">
    {!measuresOnly ? <div className="grid gap-3 sm:grid-cols-2">
      <ReportSelect label={t('genericReports.hierarchy')} value={config.hierarchy} onChange={value => onChange({ ...config, hierarchy: value === 'root_tasks' ? 'root_tasks' : 'all_tasks' })}><option value="all_tasks">{t('genericReports.allTasks')}</option><option value="root_tasks">{t('genericReports.rootTasks')}</option></ReportSelect>
      <ReportSelect label={t('genericReports.groupBy')} value={config.groupBy.kind === 'category' ? `category:${config.groupBy.fieldId}` : config.groupBy.kind} onChange={value => onChange({ ...config, groupBy: value.startsWith('category:') ? { kind: 'category', fieldId: value.slice(9) } : { kind: value === 'assignee' || value === 'status' || value === 'section' ? value : 'none' } })}>
        {(['none', 'assignee', 'status', 'section'] as const).map(kind => <option key={kind} value={kind}>{t(`genericReports.group.${kind}`)}</option>)}
        {config.groupBy.kind === 'category' && !active.some(field => field.id === ('fieldId' in config.groupBy ? config.groupBy.fieldId : '')) ? <option value={`category:${config.groupBy.fieldId}`}>{t('genericReports.unavailableField')}</option> : null}
        {active.filter(field => field.type === 'single_select').map(field => <option key={field.id} value={`category:${field.id}`}>{field.name}</option>)}
      </ReportSelect>
    </div> : null}
    <div className="space-y-2"><h3 className="text-sm font-medium">{t('genericReports.measures')}</h3>{config.measures.map((measure, index) => <div key={measure.key} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <ReportSelect label={t('genericReports.calculation', { number: index + 1 })} value={measure.operation} onChange={value => { const operation = value === 'sum' || value === 'avg' || value === 'count_values' ? value : 'count_tasks'; onChange({ ...config, measures: config.measures.map((item, at) => at !== index ? item : operation === 'count_tasks' ? { key: item.key, operation } : { key: item.key, operation, fieldId: 'fieldId' in item ? item.fieldId : numeric[0]?.id ?? '' }) }); }}>
        {(['sum', 'avg', 'count_values', 'count_tasks'] as const).map(operation => <option key={operation} value={operation}>{t(`genericReports.operation.${operation}`)}</option>)}
      </ReportSelect>
      {'fieldId' in measure ? <ReportSelect label={t('genericReports.valueField', { number: index + 1 })} value={measure.fieldId} onChange={fieldId => onChange({ ...config, measures: config.measures.map((item, at) => at === index ? { ...measure, fieldId } : item) })}>{options(numeric, measure.fieldId)}</ReportSelect> : <p className="text-xs text-muted">{t('genericReports.countTaskHint')}</p>}
      <Button type="button" variant="ghost" size="sm" disabled={config.measures.length === 1} onClick={() => onChange({ ...config, measures: config.measures.filter((_, at) => at !== index) })}>{t('genericReports.removeMeasure')}</Button>
    </div>)}<Button type="button" size="sm" variant="ghost" disabled={config.measures.length >= 12} onClick={() => onChange({ ...config, measures: [...config.measures, { key: `m_${crypto.randomUUID().replaceAll('-', '').slice(0, 30)}`, operation: 'count_tasks' }] })}>{t('genericReports.addMeasure')}</Button><p className="text-xs text-muted">{t('genericReports.averageHint')}</p></div>
    {!measuresOnly ? <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.comparison !== null} onChange={event => onChange({ ...config, comparison: event.target.checked ? { planFieldId: durations[0]?.id ?? '', factFieldId: durations[1]?.id ?? '', completion: 'done_only' } : null })}/>{t('genericReports.compare')}</label>
    {config.comparison ? <div className="grid gap-3 rounded-lg bg-canvas p-3 sm:grid-cols-3">
      <ReportSelect label={t('genericReports.planField')} value={config.comparison.planFieldId} onChange={planFieldId => { if (config.comparison) onChange({ ...config, comparison: { ...config.comparison, planFieldId } }); }}>{options(durations, config.comparison.planFieldId)}</ReportSelect>
      <ReportSelect label={t('genericReports.factField')} value={config.comparison.factFieldId} onChange={factFieldId => { if (config.comparison) onChange({ ...config, comparison: { ...config.comparison, factFieldId } }); }}>{options(durations, config.comparison.factFieldId)}</ReportSelect>
      <ReportSelect label={t('genericReports.comparisonScope')} value={config.comparison.completion} onChange={completion => { if (config.comparison) onChange({ ...config, comparison: { ...config.comparison, completion: completion === 'all_tasks' ? 'all_tasks' : 'done_only' } }); }}><option value="done_only">{t('genericReports.completedOnly')}</option><option value="all_tasks">{t('genericReports.allTasks')}</option></ReportSelect>
    </div> : null}
    <details className="rounded-lg border border-line p-3" open><summary className="cursor-pointer text-sm font-medium">{t('genericReports.filters')}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <ReportSelect label={t('genericReports.completion')} value={config.filters.statusGroups.length === 1 ? config.filters.statusGroups[0] ?? 'all' : 'all'} onChange={value => patchFilters({ statusGroups: value === 'done' || value === 'todo' || value === 'in_progress' || value === 'cancelled' ? [value] : [] })}><option value="all">{t('genericReports.allTasks')}</option><option value="done">{t('genericReports.completedOnly')}</option><option value="todo">{t('genericReports.todo')}</option><option value="in_progress">{t('genericReports.inProgress')}</option><option value="cancelled">{t('genericReports.cancelled')}</option></ReportSelect>
      <ReportSelect label={t('genericReports.assignee')} value={config.filters.assignee.kind === 'member' ? config.filters.assignee.membershipId : config.filters.assignee.kind} onChange={value => patchFilters({ assignee: value === 'all' || value === 'unassigned' ? { kind: value } : { kind: 'member', membershipId: value } })}><option value="all">{t('genericReports.everyone')}</option><option value="unassigned">{t('genericReports.unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</ReportSelect>
      <ReportSelect label={t('genericReports.dateFilter')} value={config.filters.dateRange === null ? 'all' : config.filters.dateRange.source.kind === 'due_date' ? 'due_date' : config.filters.dateRange.source.fieldId} onChange={value => patchFilters({ dateRange: value === 'all' ? null : { source: value === 'due_date' ? { kind: 'due_date' } : { kind: 'field', fieldId: value }, from: config.filters.dateRange?.from ?? calendarRange('week').from, to: config.filters.dateRange?.to ?? calendarRange('week').to } })}><option value="all">{t('genericReports.allTime')}</option><option value="due_date">{t('genericReports.dueDate')}</option>{config.filters.dateRange?.source.kind === 'field' && !active.some(field => field.id === (config.filters.dateRange?.source.kind === 'field' ? config.filters.dateRange.source.fieldId : '')) ? <option value={config.filters.dateRange.source.fieldId}>{t('genericReports.unavailableField')}</option> : null}{active.filter(field => field.type === 'date').map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</ReportSelect>
      {config.filters.dateRange ? <ReportSelect label={t('genericReports.rangePreset')} value={preset} onChange={value => { setPreset(value); if (config.filters.dateRange && (value === 'week' || value === 'month')) patchFilters({ dateRange: { ...config.filters.dateRange, ...calendarRange(value) } }); }}><option value="custom">{t('genericReports.customRange')}</option><option value="week">{t('genericReports.weekPreset')}</option><option value="month">{t('genericReports.monthPreset')}</option></ReportSelect> : null}
      {config.filters.dateRange ? <div className="grid grid-cols-2 gap-2">{(['from', 'to'] as const).map(boundary => <label key={boundary} className="grid gap-1 text-xs text-muted">{t(`genericReports.${boundary}`)}<TextInput type="date" value={config.filters.dateRange?.[boundary] ?? ''} onChange={event => { if (config.filters.dateRange) { setPreset('custom'); patchFilters({ dateRange: { ...config.filters.dateRange, [boundary]: event.target.value } }); } }}/></label>)}</div> : null}
      {tags.length ? <fieldset className="sm:col-span-2"><legend className="text-xs text-muted">{t('genericReports.tags')}</legend><div className="mt-1 flex flex-wrap gap-3">{tags.map(tag => <label key={tag.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={config.filters.tagIds.includes(tag.id)} onChange={event => patchFilters({ tagIds: event.target.checked ? [...config.filters.tagIds, tag.id] : config.filters.tagIds.filter(id => id !== tag.id) })}/>{tag.name}</label>)}</div></fieldset> : null}
      <Button type="button" variant="ghost" size="sm" onClick={() => patchFilters({ statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null })}>{t('genericReports.clearFilters')}</Button>
    </div></details>
    <p className="text-xs text-muted">{t('genericReports.scopeHint')}</p></> : null}
  </fieldset>;
}
