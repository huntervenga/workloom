import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Pencil, Settings2, X } from 'lucide-react';
import { Button, TextInput } from '@workloom/ui';
import { genericHeaderWidgetSchema, type GenericHeaderWidgetDto, type GenericHeaderWidgetGroupDto, type GenericHeaderWidgetRuleDto, type GenericHeaderWidgetsResultDto, type MembershipDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { ReportSelect } from './ReportConfigEditor';
import { reportNumber } from './ReportResults';
import { operationLabels } from './translationKeys';
import { columnOperations, type ColumnOperation } from './ColumnAggregateCell';
export function sameWidgetGroup(a: GenericHeaderWidgetGroupDto, b: GenericHeaderWidgetGroupDto): boolean { return a.kind === b.kind && (a.kind === 'section' ? b.kind === 'section' && a.sectionId === b.sectionId : b.kind === 'assignee' && a.membershipId === b.membershipId); }
export function replaceHeaderWidgets(rules: readonly GenericHeaderWidgetRuleDto[], group: GenericHeaderWidgetGroupDto, widgets: GenericHeaderWidgetDto[]): GenericHeaderWidgetRuleDto[] { return [...rules.filter(rule => !sameWidgetGroup(rule.group, group)), ...(widgets.length ? [{ group, widgets }] : [])]; }
const sameWidgetList=(a:readonly GenericHeaderWidgetDto[],b:readonly GenericHeaderWidgetDto[])=>JSON.stringify(a.map(widget=>genericHeaderWidgetSchema.parse(widget)))===JSON.stringify(b.map(widget=>genericHeaderWidgetSchema.parse(widget)));
const minutesText = (minutes: number) => reportNumber({ numerator: String(minutes), denominator: '1', decimal: String(minutes) }, 'minutes');
type SummaryValidation='limit'|'field'|'person'|'manual'|'range';
interface WidgetForm { editingKey: string | null; kind: string; fieldId: string; membershipId: string; operation: ColumnOperation; range: string; from: string; to: string; manual: boolean; minutes: string; note: string }
const emptyForm = ():WidgetForm => ({editingKey:null,kind:'measure',fieldId:'',membershipId:'',operation:'sum',range:'project_dates',from:'',to:'',manual:false,minutes:'',note:''});
/** One public schema validates both ordinary metrics and optional manual display overrides. */
export function headerWidgetFromForm(form:WidgetForm,key:string):GenericHeaderWidgetDto|null {
 const range=form.range==='project_dates'?{kind:'project_dates'}:form.range==='this_week'?{kind:'this_week'}:{kind:'dates',from:form.from,to:form.to};
 const candidate=form.kind==='measure'?{key,kind:'measure',measure:{key,operation:form.operation,fieldId:form.fieldId}}:{key,kind:'capacity',membershipId:form.membershipId,range,...(form.manual?{override:{minutes:form.minutes.trim()===''?NaN:Number(form.minutes),...(form.note.trim()?{note:form.note.trim()}:{})}}:{})};
 const parsed=genericHeaderWidgetSchema.safeParse(candidate);return parsed.success?parsed.data:null;
}
export function HeaderWidgets({ group, title, rules, result, fields, members, workspaceId, writable, disabled, loading, revision, feedback, uncertain, projectDateRange, onRetry, onSave }: { group: GenericHeaderWidgetGroupDto; title: string; rules: readonly GenericHeaderWidgetRuleDto[]; result: GenericHeaderWidgetsResultDto | undefined; fields: readonly TaskFieldDefinitionDto[]; members: readonly MembershipDto[]; workspaceId: string; writable: boolean; disabled: boolean; loading: boolean; revision: number; feedback: ReactNode; uncertain: boolean; projectDateRange:{from:string;to:string}|null; onRetry: (onSuccess: () => void) => void; onSave: (widgets: GenericHeaderWidgetDto[], revision: number, onSuccess: () => void) => void }) {
 const { t } = useTranslation();
 const [draft,setDraft]=useState<GenericHeaderWidgetDto[]|null>(null),[draftRevision,setDraftRevision]=useState(revision),[form,setForm]=useState<WidgetForm>(emptyForm);
 const [openingWidgets,setOpeningWidgets]=useState<GenericHeaderWidgetDto[]>([]),[formBaseline,setFormBaseline]=useState<WidgetForm>(emptyForm),[validation,setValidation]=useState<SummaryValidation|null>(null);
 const validationRef=useRef<HTMLParagraphElement>(null);
 const validationMessages={limit:t('genericReports.tableAggregates.summaryLimit'),field:t('genericReports.tableAggregates.chooseAvailableField'),person:t('genericReports.tableAggregates.chooseAvailablePerson'),manual:t('genericReports.tableAggregates.invalidManualValue'),range:t('genericReports.tableAggregates.invalidSummaryRange')};
 const canEdit=writable&&!disabled&&!uncertain;
 const formChanged=JSON.stringify(form)!==JSON.stringify(formBaseline);
 useProtectedDraft(draft!==null&&(!sameWidgetList(draft,openingWidgets)||formChanged));
 const saved=rules.find(rule=>sameWidgetGroup(rule.group,group))?.widgets??[],resolved=result?.settingsRevision===revision?result.groups.find(item=>sameWidgetGroup(item.group,group)):undefined;
 const numeric=fields.filter(field=>field.archivedAt===null&&(field.type==='number'||field.type==='duration'));
 const patch=(part:Partial<WidgetForm>)=>{setValidation(null);setForm(part.kind!==undefined&&part.kind!==form.kind?{...emptyForm(),editingKey:form.editingKey,...part}:{...form,...part});};
 const resetForm=()=>{setForm(emptyForm());setFormBaseline(emptyForm());setValidation(null);};
 const widgetLabel=(widget:GenericHeaderWidgetDto)=>widget.label??(widget.kind==='measure'?`${'fieldId' in widget.measure?fields.find(field=>'fieldId' in widget.measure&&field.id===widget.measure.fieldId)?.name??t('genericReports.unavailableField'):t('genericReports.task')} · ${t(operationLabels[widget.measure.operation])}`:`${members.find(member=>member.id===widget.membershipId)?.displayName??t('genericReports.formerMember')} · ${t('genericReports.tableAggregates.available')}`);
 const candidate=headerWidgetFromForm(form,form.editingKey??'draft'),validSource=form.kind==='measure'?numeric.some(field=>field.id===form.fieldId):members.some(member=>member.id===form.membershipId);
 const hasEditor=form.editingKey!==null||JSON.stringify(form)!==JSON.stringify(emptyForm());
 // Focus the newly mounted error in this commit, before another user action can open a picker.
 useLayoutEffect(()=>{if(validation!==null)validationRef.current?.focus();},[validation]);
 const showValidation=(key:SummaryValidation)=>{if(validation===key)validationRef.current?.focus();setValidation(key);};
 /** Both Save and Add another use this path. A failed save retains the same staged key. */
 const applyEditor=():GenericHeaderWidgetDto[]|null=>{
  if(draft===null||!canEdit)return null;
  if(!hasEditor)return draft;
  if(!form.editingKey&&draft.length>=4){showValidation('limit');return null;}
  if(!validSource){showValidation(form.kind==='measure'?'field':'person');return null;}
  if(!candidate){showValidation(form.kind==='capacity'&&form.manual?'manual':'range');return null;}
  const parsed=headerWidgetFromForm(form,form.editingKey??`w_${crypto.randomUUID()}`);if(!parsed)return null;
  const previous=draft.find(item=>item.key===form.editingKey);
  const labeled=previous?.label?{...parsed,label:previous.label}:parsed;
  const widget=labeled.kind==='measure'&&previous?.kind==='measure'?{...labeled,measure:{...labeled.measure,key:previous.measure.key}}:labeled;
  const next=form.editingKey?draft.map(item=>item.key===form.editingKey?widget:item):[...draft,widget];
  setDraft(next);resetForm();return next;
 };
 const add=()=>{applyEditor();};
 const save=()=>{if(draft===null||!canEdit)return;const next=form.editingKey!==null&&!formChanged?draft:applyEditor();if(next===null)return;if(sameWidgetList(next,openingWidgets)){setDraft(null);return;}onSave(next,draftRevision,()=>setDraft(null));};
 const edit=(widget:GenericHeaderWidgetDto)=>{
  const next:WidgetForm=widget.kind==='measure'?{...emptyForm(),editingKey:widget.key,kind:'measure',fieldId:'fieldId'in widget.measure?widget.measure.fieldId:'',operation:widget.measure.operation==='count_tasks'?'sum':widget.measure.operation}:{...emptyForm(),editingKey:widget.key,kind:'capacity',membershipId:widget.membershipId,range:widget.range.kind,from:widget.range.kind==='dates'?widget.range.from:'',to:widget.range.kind==='dates'?widget.range.to:'',manual:widget.override!==undefined,minutes:widget.override?String(widget.override.minutes):'',note:widget.override?.note??''};
  setForm(next);setFormBaseline(next);setValidation(null);
 };
 return <div className="flex min-w-0 items-center gap-2" data-section-widgets="">
  {saved.map(widget=>{const value=resolved?.widgets.find(item=>item.key===widget.key),label=widgetLabel(widget);const amount=value?.kind==='capacity'?value.displayAvailableMinutes:null;const formatted=loading&&!value?'…':value?.kind==='measure'&&value.unavailableReason===null&&value.result?reportNumber(value.result.value,value.result.unit):amount!==null&&amount!==undefined?minutesText(amount):'—';const unavailable=value?.unavailableReason==='project_dates_missing'?t('genericReports.tableAggregates.projectDatesMissing'):value?.unavailableReason==='project_dates_too_long'?t('genericReports.tableAggregates.projectDatesTooLong'):value?.unavailableReason==='schedule_unknown'?t('genericReports.tableAggregates.unknownSchedule'):value?.unavailableReason?t('genericReports.tableAggregates.unavailableWidget'):'';const hint=value?.kind==='capacity'?`${value.range?t('genericReports.tableAggregates.capacityScope',{person:value.person?.displayName??t('genericReports.formerMember'),from:value.range.from,to:value.range.to}):unavailable||t('genericReports.tableAggregates.projectDatesMissing')}${value.manualOverride?` · ${t('genericReports.tableAggregates.manualHelp')}`:''}${unavailable?` · ${unavailable}`:''}`:unavailable||t('genericReports.tableAggregates.fullScope');return <span key={widget.key} title={hint} className="inline-flex max-w-64 items-center gap-1.5 truncate rounded border border-line bg-surface px-2 py-1 text-[11px] font-normal text-muted"><span className="truncate">{label}</span>{value?.kind==='capacity'&&value.manualOverride?<span className="rounded bg-canvas px-1 text-[10px] text-ink-soft">{t('genericReports.tableAggregates.manual')}</span>:null}<strong className="shrink-0 font-medium tabular-nums text-ink">{formatted}</strong></span>;})}
  {writable?<button type="button" disabled={!canEdit} onClick={()=>{setDraftRevision(revision);setDraft([...saved]);setOpeningWidgets([...saved]);resetForm();}} aria-label={t('genericReports.tableAggregates.configureHeader',{group:title})} className="rounded p-1.5 text-muted hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"><Settings2 size={13} aria-hidden="true"/></button>:null}
  <DialogShell open={draft!==null} onOpenChange={open=>{if(!open&&!disabled)setDraft(null);}} title={t('genericReports.tableAggregates.headerTitle',{group:title})} description={t('genericReports.tableAggregates.headerHelp')}><div className="space-y-3">
   {(draft??[]).map(widget=><div key={widget.key} className="flex items-center justify-between gap-2 rounded border border-line p-2 text-sm"><span>{widgetLabel(widget)}{widget.kind==='capacity'&&widget.override?` · ${t('genericReports.tableAggregates.manual')} ${minutesText(widget.override.minutes)}`:''}</span><div className="flex gap-2"><button type="button" disabled={!canEdit} aria-label={t('genericReports.tableAggregates.editWidget',{widget:widgetLabel(widget)})} onClick={()=>edit(widget)}><Pencil size={14} aria-hidden="true"/></button><button type="button" disabled={!canEdit} aria-label={t('genericReports.tableAggregates.removeWidget',{widget:widgetLabel(widget)})} onClick={()=>{setDraft((draft??[]).filter(item=>item.key!==widget.key));if(form.editingKey===widget.key)resetForm();}}><X size={14} aria-hidden="true"/></button></div></div>)}
   <ReportSelect label={t('genericReports.tableAggregates.widgetType')} value={form.kind} onChange={kind=>patch({kind})} disabled={!canEdit}><option value="measure">{t('genericReports.tableAggregates.fieldTotal')}</option><option value="capacity">{t('genericReports.tableAggregates.personCapacity')}</option></ReportSelect>
   {form.kind==='measure'?<><ReportSelect label={t('genericReports.tableAggregates.field')} value={form.fieldId} onChange={fieldId=>patch({fieldId})} disabled={!canEdit}><option value="">{t('genericReports.chooseField')}</option>{numeric.map(field=><option key={field.id} value={field.id}>{field.name}</option>)}</ReportSelect><ReportSelect label={t('genericReports.tableAggregates.calculation')} value={form.operation} onChange={operation=>patch({operation:operation as ColumnOperation})} disabled={!canEdit}>{columnOperations.map(value=><option key={value} value={value}>{t(operationLabels[value])}</option>)}</ReportSelect></>:<>
    <ReportSelect label={t('genericReports.tableAggregates.person')} value={form.membershipId} onChange={membershipId=>patch({membershipId})} disabled={!canEdit}><option value="">{t('genericReports.tableAggregates.choosePerson')}</option>{members.map(member=><option key={member.id} value={member.id}>{member.displayName}</option>)}</ReportSelect>
    <ReportSelect label={t('genericReports.tableAggregates.period')} value={form.range} onChange={range=>patch({range})} disabled={!canEdit}><option value="project_dates">{t('genericReports.tableAggregates.projectDates')}</option><option value="this_week">{t('genericReports.weekPreset')}</option><option value="dates">{t('genericReports.customRange')}</option></ReportSelect>
    {form.range==='project_dates'?<p className="text-xs text-muted">{projectDateRange?t('genericReports.tableAggregates.projectRangeValue',projectDateRange):t('genericReports.tableAggregates.projectDatesMissing')}</p>:null}
    {form.range==='dates'?<div className="grid grid-cols-2 gap-2"><label className="text-xs text-muted">{t('genericReports.from')}<TextInput type="date" value={form.from} onChange={event=>patch({from:event.target.value})} disabled={!canEdit}/></label><label className="text-xs text-muted">{t('genericReports.to')}<TextInput type="date" value={form.to} onChange={event=>patch({to:event.target.value})} disabled={!canEdit}/></label></div>:null}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.manual} disabled={!canEdit} onChange={event=>patch({manual:event.target.checked})}/>{t('genericReports.tableAggregates.manualToggle')}</label>
    {form.manual?<div className="space-y-2"><label className="grid gap-1 text-xs text-muted">{t('genericReports.tableAggregates.manualMinutes')}<TextInput type="number" min={0} max={527040} step={1} value={form.minutes} disabled={!canEdit} onChange={event=>patch({minutes:event.target.value})}/></label><label className="grid gap-1 text-xs text-muted">{t('genericReports.tableAggregates.manualNote')}<TextInput maxLength={200} value={form.note} disabled={!canEdit} onChange={event=>patch({note:event.target.value})}/></label><p className="text-xs text-muted">{t('genericReports.tableAggregates.manualHelp')}</p></div>:null}
    <p className="text-xs text-muted">{t('genericReports.tableAggregates.capacityHelp')} <Link to={`/w/${workspaceId}/time-off?tab=people${form.membershipId?`&person=${encodeURIComponent(form.membershipId)}`:''}#working-hours`} className="text-accent-ink underline">{t('genericReports.tableAggregates.scheduleSettings')}</Link></p>
   </>}
   <p className="text-xs text-muted">{t('genericReports.tableAggregates.saveIncludesEditor')}</p><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!canEdit||(!form.editingKey&&(draft?.length??0)>=4)||!candidate||!validSource} onClick={add}>{t(form.editingKey?'genericReports.tableAggregates.updateWidget':'genericReports.tableAggregates.addWidget')}</Button>{hasEditor?<Button size="sm" variant="ghost" disabled={!canEdit} onClick={resetForm}>{form.editingKey?t('genericReports.tableAggregates.cancelWidgetEdit'):t('genericReports.tableAggregates.cancelNewWidget')}</Button>:null}</div>
   {validation?<p ref={validationRef} tabIndex={-1} role="alert" className="rounded-md border border-danger-line/50 bg-danger-soft/25 p-3 text-sm text-ink">{validationMessages[validation]}</p>:null}{draftRevision!==revision?<p role="status" className="text-xs text-muted">{t('genericReports.staleDraft')}</p>:null}{feedback}{uncertain?<Button size="sm" onClick={()=>onRetry(()=>setDraft(null))}>{t('genericReports.retry')}</Button>:null}
   <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface py-3"><Button size="sm" disabled={!canEdit} onClick={save}>{t('genericReports.tableAggregates.saveWidgets')}</Button><Button size="sm" variant="ghost" disabled={!canEdit} onClick={()=>setDraft(null)}>{t('genericReports.discard')}</Button></div>
  </div></DialogShell>
 </div>;
}
