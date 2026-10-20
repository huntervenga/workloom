import { ChoicePicker } from '../../shared/ChoicePicker';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, TextInput } from '@workloom/ui';
import { duplicateTaskPreviewInputSchema, duplicateSectionPreviewInputSchema, type DuplicationCopyOptions, type GenericHeaderWidgetDto, type PlanningCheckRangeDto, type DuplicationResultDto, type MembershipDto, type SectionDto, type TaskDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { queryKeys } from '../../lib/queryKeys';
import { useCurrentReportAccess } from '../generic-reports/queries';
import { useDuplicateCommand, useDuplicationPreview } from './queries';
import { duplicationErrorText } from './errors';
import type { DuplicationPreviewRequest, DuplicationWriteRequest } from './api';
export type DuplicationTarget={kind:'task'|'section';id:string;projectId:string;name:string};
const defaultCopy=():DuplicationCopyOptions=>({description:true,assignee:true,dates:true,tags:true,priority:true,participants:true,subtasks:true,customFieldIds:[]});
interface DuplicationProps{actorId:string;workspaceId:string;projectId:string;fields:readonly TaskFieldDefinitionDto[];members:readonly MembershipDto[];writable:boolean;onDuplicated:(result:DuplicationResultDto)=>void}
export function useDuplication(props:DuplicationProps){
 const[target,setTarget]=useState<DuplicationTarget|null>(null),command=useDuplicateCommand(props.actorId,props.workspaceId),client=useQueryClient();
 const open=(next:DuplicationTarget)=>{if(!props.writable||command.pendingCommand||command.uncertain||next.projectId!==props.projectId)return;command.reset();setTarget(next);};
 const done=(result:DuplicationResultDto)=>{setTarget(null);if(client.getQueryData<{actor:{id:string}}>(queryKeys.me)?.actor.id===props.actorId)props.onDuplicated(result);};
 return{openTask:(task:TaskDto)=>{if(task.archivedAt===null&&task.meetingId===null)open({kind:'task',id:task.id,projectId:task.projectId,name:task.title});},openSection:(section:SectionDto)=>{if(section.archivedAt===null)open({kind:'section',id:section.id,projectId:section.projectId,name:section.name});},held:command.pendingCommand!==null||command.uncertain!==null,dialog:target?<DuplicationForm key={`${target.kind}:${target.id}`} {...props} target={target} command={command} onClose={()=>setTarget(null)} onDone={done}/>:null};
}
function DuplicationForm({target,command,onClose,onDone,...props}:DuplicationProps&{target:DuplicationTarget;command:ReturnType<typeof useDuplicateCommand>;onClose:()=>void;onDone:(result:DuplicationResultDto)=>void}){
 const{t}=useTranslation(),client=useQueryClient(),access=useCurrentReportAccess(props.actorId,props.workspaceId,props.projectId);
 const canCopy=props.writable&&access!=='blocked'&&access!=='viewer',canCopySettings=canCopy&&(access==='owner'||access==='admin');
 const[initialName]=useState(()=>t('duplication.copyName',{name:target.name}).slice(0,target.kind==='task'?500:160)),[initialSettings]=useState(canCopySettings);
 const[name,setName]=useState(initialName),[copy,setCopy]=useState(defaultCopy),[includeTasks,setIncludeTasks]=useState(true),[includeSettings,setIncludeSettings]=useState(initialSettings),[closeHeld,setCloseHeld]=useState(false),[templateMode,setTemplateMode]=useState<'keep_link'|'independent'>('independent');
 const held=command.pendingCommand!==null||command.uncertain!==null,registry=protectedCommandsFor(client),protectedSave=useSyncExternalStore(registry.subscribe,registry.getSnapshot,registry.getSnapshot);
 const busy=held||!canCopy,taskOptions=target.kind==='task'||includeTasks;
 const request=useMemo<DuplicationPreviewRequest>(()=>target.kind==='task'?{kind:'task',sourceId:target.id,projectId:props.projectId,input:{projectId:props.projectId,title:name,copy}}:{kind:'section',sourceId:target.id,projectId:props.projectId,input:{name,includeTasks,includeSettings,copy,...(includeSettings?{templateMode}:{})}},[target.kind,target.id,props.projectId,name,copy,includeTasks,includeSettings,templateMode]);
 const valid=(request.kind==='task'?duplicateTaskPreviewInputSchema:duplicateSectionPreviewInputSchema).safeParse(request.input).success;
 const fingerprint=JSON.stringify(request),[settled,setSettled]=useState({key:fingerprint,request});
 useEffect(()=>{if(settled.key===fingerprint)return;const timer=setTimeout(()=>setSettled({key:fingerprint,request}),200);return()=>clearTimeout(timer);},[fingerprint,request,settled.key]);
 const currentInput=settled.key===fingerprint,permitted=canCopy&&(target.kind==='task'||!includeSettings||canCopySettings);
 const preview=useDuplicationPreview(props.actorId,props.workspaceId,settled.request,valid&&currentInput&&permitted&&!held);
 const confirmed=permitted&&valid&&currentInput&&command.error===null&&preview.isSuccess&&!preview.isFetching&&preview.data.projectId===props.projectId?preview.data:undefined;
 const fields=props.fields.filter(field=>field.workspaceId===props.workspaceId&&field.projectId===props.projectId&&field.archivedAt===null);
 const changed=name!==initialName||JSON.stringify(copy)!==JSON.stringify(defaultCopy())||!includeTasks||(target.kind==='section'&&includeSettings!==initialSettings)||(target.kind==='section'&&templateMode!=='independent');
 useProtectedDraft(changed&&!held);
 const close=()=>{if(held){setCloseHeld(true);return;}onClose();};
 const submit=()=>{
  if(!confirmed||busy||protectedSave||command.hasOtherProtectedCommands())return;
  const sourceVersion=confirmed.sourceVersion;
  const write:DuplicationWriteRequest=request.kind==='task'?{...request,input:{...request.input,expectedSourceVersion:sourceVersion}}:{...request,input:{...request.input,expectedSourceVersion:sourceVersion}};
  command.mutate({request:write},{onSuccess:onDone});
 };
 const options=[['description',t('duplication.options.description')],['assignee',t('duplication.options.assignee')],['dates',t('duplication.options.dates')],['tags',t('duplication.options.tags')],['priority',t('duplication.options.priority')],['participants',t('duplication.options.participants')],['subtasks',t('duplication.options.subtasks')]] as const;
 const personText=(membershipId:string)=>props.members.find(member=>member.id===membershipId)?.displayName??t('genericReports.formerMember');
 const fieldText=(fieldId:string)=>fields.find(field=>field.id===fieldId)?.name??t('genericReports.unavailableField');
 const rangeText=(range:PlanningCheckRangeDto)=>range.kind==='dates'?t('genericReports.tableAggregates.projectRangeValue',{from:range.from,to:range.to}):range.kind==='project_dates'?t('genericReports.tableAggregates.projectDates'):t('duplication.thisWeek');
 const capacityText=(membershipId:string,range:PlanningCheckRangeDto,minutes?:number,note?:string)=>[personText(membershipId),rangeText(range),...(minutes===undefined?[]:[t('duplication.manualReference',{minutes})]),...(note?[note]:[])].join(' · ');
 const widgetText=(widget:GenericHeaderWidgetDto)=>[...(widget.label?[widget.label]:[]),widget.kind==='capacity'?capacityText(widget.membershipId,widget.range,widget.override?.minutes,widget.override?.note):widget.kind==='personal_effort'?`${fieldText(widget.fieldId)} · ${t('summaryTemplates.personalEffort')}`:'fieldId'in widget.measure?fieldText(widget.measure.fieldId):t('genericReports.task')].join(' · ');
 const title=t(target.kind==='task'?'duplication.taskAction':'duplication.sectionAction');
 return<DialogShell open onOpenChange={open=>{if(!open)close();}} title={title} description={t('duplication.help')}><form className="mt-4 space-y-4" onSubmit={event=>{event.preventDefault();submit();}}>
  <label className="block text-xs text-muted">{t(target.kind==='task'?'duplication.taskTitle':'duplication.sectionName')}<TextInput autoFocus value={name} maxLength={target.kind==='task'?500:160} disabled={busy} onChange={event=>{command.reset();setName(event.target.value);}}/></label>
  {target.kind==='section'?<div className="space-y-2"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={includeTasks} disabled={busy} onChange={event=>{command.reset();setIncludeTasks(event.target.checked);}}/>{t('duplication.includeTasks')}</label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={includeSettings} disabled={busy||!canCopySettings} onChange={event=>{command.reset();setIncludeSettings(event.target.checked);}}/>{t('duplication.includeSettings')}</label>{!canCopySettings?<p className="text-xs text-muted">{t('duplication.settingsPermission')}</p>:null}</div>:null}
  {target.kind==='section'&&includeSettings&&confirmed?.settings?.templateBinding?<div className="space-y-1"><ChoicePicker compact label={t('summaryTemplates.duplicateMode')} value={templateMode} disabled={busy} options={[{value:'independent',label:t('summaryTemplates.independentCopy')},{value:'keep_link',label:t('summaryTemplates.keepLink')}]} onValueChange={mode=>{command.reset();setTemplateMode(mode==='keep_link'?'keep_link':'independent');}}/><p className="text-xs text-muted">{t('summaryTemplates.linkCopyHelp')}</p></div>:null}
  <fieldset disabled={busy||!taskOptions} className="grid grid-cols-2 gap-2 disabled:opacity-50">{options.map(([key,label])=><label key={key} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={copy[key]} onChange={event=>{command.reset();setCopy({...copy,[key]:event.target.checked});}}/>{label}</label>)}</fieldset>
  {taskOptions?<fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">{t('duplication.customFields')}</legend><p className="text-xs text-muted">{t('duplication.customFieldsHelp')}</p><div className="max-h-36 space-y-2 overflow-y-auto rounded-lg border border-line p-2">{fields.length?fields.map(field=><label key={field.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={copy.customFieldIds.includes(field.id)} onChange={event=>{command.reset();setCopy({...copy,customFieldIds:event.target.checked?[...copy.customFieldIds,field.id]:copy.customFieldIds.filter(id=>id!==field.id)});}}/><span className="min-w-0 truncate">{field.name}</span></label>):<p className="text-xs text-muted">{t('duplication.noFields')}</p>}</div></fieldset>:null}
  <p className="text-xs text-muted">{t('duplication.taskReset')}</p>
  <div className="min-h-12 rounded-lg bg-canvas p-3 text-xs text-muted" aria-live="polite">{confirmed?<><p>{t('duplication.previewCount',{count:confirmed.taskCount})}</p><p>{t('duplication.previewValues',{count:confirmed.customValueCount})}</p>{confirmed.settings?<div className="mt-2 space-y-1"><p className="font-medium text-ink">{t('duplication.copiedSettings')}</p><p>{t('duplication.summaryCount',{count:confirmed.settings.headerWidgets.reduce((sum,rule)=>sum+rule.widgets.length,0)})} · {t('duplication.checkCount',{count:confirmed.settings.balanceChecks.length})}</p><ul className="list-inside list-disc">{confirmed.settings.headerWidgets.flatMap(rule=>rule.widgets).map(widget=><li key={widget.key}>{widgetText(widget)}</li>)}{confirmed.settings.balanceChecks.map(rule=><li key={rule.id}>{rule.name}{rule.kind==='balance'?` · ${fieldText(rule.sumFieldId)}${rule.target.kind==='capacity'?` · ${capacityText(rule.target.membershipId,rule.target.range,rule.target.basis==='configured_manual'?rule.target.manualMinutes:undefined)}`:''}`:''}</li>)}</ul><p>{t('duplication.sharedReferences')}</p></div>:null}</>:!permitted?t('duplication.checkingAccess'):command.error&&!command.uncertain?duplicationErrorText(command.error):preview.isError&&currentInput?<><p>{duplicationErrorText(preview.error)}</p><Button type="button" size="sm" variant="ghost" onClick={()=>void preview.refetch()}>{t('duplication.refreshPreview')}</Button></>:valid?t('duplication.previewing'):null}</div>
  <SaveFeedback error={command.error} uncertainError={command.uncertain?.error??null} subject={target.kind==='task'?'taskSave':'sectionSave'}/>
  {command.error&&!command.uncertain?<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>{command.reset();void preview.refetch();}}>{t('duplication.refreshPreview')}</Button>:null}
  {closeHeld&&held?<p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{t('duplication.closeHeld')}</p>:null}
  {protectedSave&&!held?<p role="status" className="text-xs text-muted">{t('duplication.otherSave')}</p>:null}
  <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-surface pt-3">{command.uncertain?<Button type="button" size="sm" variant="primary" disabled={command.pendingCommand!==null||!permitted||command.hasOtherProtectedCommands()} onClick={()=>command.retryUncertain({onSuccess:onDone})}>{t('duplication.retrySame')}</Button>:<Button type="submit" size="sm" variant="primary" disabled={!confirmed||busy||protectedSave}>{command.pendingCommand?t('duplication.pending'):title}</Button>}<Button type="button" size="sm" variant="ghost" disabled={held} onClick={close}>{t('duplication.cancel')}</Button></div>
 </form></DialogShell>;
}
