import { useEffect, useRef, useState } from 'react';
import type { MembershipDto, SharedActivityConfiguration, SharedActivityContributionDto, TaskDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { ReportSelect } from '../generic-reports/ReportConfigEditor';
import { useTaskFieldValuesQuery } from '../fields/queries';
import { SharedActivityFields } from './SharedActivityFields';
import { attendanceInput, attendanceRows, configurationPlanRevision, configurationFromRecord, emptyActivityConfiguration, validConfiguration } from './model';
import { useSharedActivityRecord, type SharedActivityWorkspace, type SharedConfigurationDraft } from './queries';
type ActivityNotice='invalidConfiguration'|'invalidAttendance'|'ordinaryUnresolved'|'sourceChanged';
type Attendance='unconfirmed'|'present'|'partial'|'absent';
/** A change that still needs one more thing (minutes, or a reason for correcting saved time) before it can be saved. */
interface PendingRow{attendance:Attendance;minutes:string;reason:string;void:boolean}
const AUTOSAVE_DELAY_MS=800;
const safeLink=(url:string|null)=>url&&/^https?:\/\//i.test(url)?url:null;
const isCorrection=(source:SharedActivityContributionDto)=>source.postingState!=='unconfirmed'||source.confirmedActivityRevision!==null;
export function SharedActivityPanel({controller,task,fields,members,writable,current,beforeCommand}:{controller:SharedActivityWorkspace;task:TaskDto;fields:readonly TaskFieldDefinitionDto[];members:readonly MembershipDto[];writable:boolean;current:boolean;beforeCommand:()=>Promise<TaskDto>}){
 const{t}=useTranslation(),query=useSharedActivityRecord(controller.actorId,controller.workspaceId,task.id,task.revision,current),values=useTaskFieldValuesQuery(controller.actorId,controller.workspaceId,task.id);
 const noticeMessages:Record<ActivityNotice,string>={invalidConfiguration:t('sharedActivities.invalidConfiguration'),invalidAttendance:t('sharedActivities.invalidAttendance'),ordinaryUnresolved:t('sharedActivities.ordinaryUnresolved'),sourceChanged:t('sharedActivities.sourceChanged')};
 const[preparing,setPreparing]=useState(false),[notice,setNotice]=useState<{kind:ActivityNotice}|null>(null);
 const[edited,setEdited]=useState<SharedActivityConfiguration|null>(null),[pending,setPending]=useState<Record<string,PendingRow>>({});
 const record=query.isSuccess&&!query.isError?query.data:null,draft=controller.drafts[task.id]??{},setup=draft.setup;
 const configure=controller.configure,confirm=controller.attendance,held=[configure,confirm].some(command=>command.pendingCommand!==null||command.uncertain!==null),disabled=!current||preparing||held;
 const canConfigure=writable&&current&&(!record||record.permissions.canEditActivity),canAttend=!!record&&current&&(record.permissions.canWriteSelf||record.permissions.canWriteOthers);
 const setDraft=(patch:typeof draft)=>controller.setTaskDraft(task.id,{...draft,...patch});
 const clearSetup=()=>{const{setup:old,...rest}=draft;void old;controller.setTaskDraft(task.id,rest);};
 // Settings of an existing call are saved as they change; only an edit still waiting for its save blocks leaving.
 useProtectedDraft(edited!==null);
 const freshSetup=async(configuration:SharedActivityConfiguration):Promise<SharedConfigurationDraft|null>=>{
  const freshTask=await beforeCommand(),fresh=await query.refetch(),freshValues=await values.refetch();
  if(!fresh.isSuccess||!freshValues.isSuccess||freshTask.id!==task.id||freshTask.projectId!==controller.projectId){setNotice({kind:'sourceChanged'});return null;}
  return{configuration,record:fresh.data,taskRevision:freshTask.revision,planValueRevision:fresh.data?.planValueRevision??0,valueRevisions:Object.fromEntries(freshValues.data.map(value=>[value.fieldId,value.revision])),baseline:JSON.stringify(configuration)};
 };
 /** First setup of a task that is not a call yet: an explicit choice, saved once with the button. */
 const begin=async()=>{if(disabled||!canConfigure)return;setPreparing(true);setNotice(null);try{const prepared=await freshSetup(emptyActivityConfiguration(members.find(member=>member.userId===controller.actorId)?.id??'',task.dueDate??''));if(prepared)setDraft({setup:prepared});}catch{setNotice({kind:'ordinaryUnresolved'});}finally{setPreparing(false);}};
 const save=async()=>{if(!setup||disabled||!canConfigure||!values.isSuccess||values.isFetching)return;setPreparing(true);setNotice(null);try{await beforeCommand();if(configure.hasOtherProtectedCommands())return;const parsed=validConfiguration(setup.taskRevision,setup.record?.activity.revision??0,configurationPlanRevision(setup),setup.configuration);if(!parsed.success){setNotice({kind:'invalidConfiguration'});return;}configure.mutate({taskId:task.id,input:parsed.data},{onSuccess:clearSetup});}catch{setNotice({kind:'ordinaryUnresolved'});}finally{setPreparing(false);}};
 const autosaveEdited=async(next:SharedActivityConfiguration)=>{
  setPreparing(true);setNotice(null);
  try{
   const prepared=await freshSetup(next);if(!prepared)return;
   if(configure.hasOtherProtectedCommands())return;
   const parsed=validConfiguration(prepared.taskRevision,prepared.record?.activity.revision??0,configurationPlanRevision(prepared),next);
   if(!parsed.success){setNotice({kind:'invalidConfiguration'});return;}
   configure.mutate({taskId:task.id,input:parsed.data},{onSuccess:()=>setEdited(null)});
  }catch{setNotice({kind:'ordinaryUnresolved'});}finally{setPreparing(false);}
 };
 const savedConfiguration=record?configurationFromRecord(record):null,shown=edited??savedConfiguration;
 const editedKey=edited===null?null:JSON.stringify(edited),savedKey=savedConfiguration===null?null:JSON.stringify(savedConfiguration);
 const autosaveRef=useRef(autosaveEdited);autosaveRef.current=autosaveEdited;
 useEffect(()=>{
  if(edited===null||disabled||!canConfigure)return;
  if(editedKey===savedKey){setEdited(null);return;}
  const timer=setTimeout(()=>void autosaveRef.current(edited),AUTOSAVE_DELAY_MS);
  return()=>clearTimeout(timer);
 },[edited,editedKey,savedKey,disabled,canConfigure]);
 /** Saves attendance for the given people at once; the latest saved revisions are read first. */
 const commitAttendance=async(changes:readonly{id:string;row:PendingRow}[],onDone?:()=>void)=>{
  if(disabled||!canAttend)return;
  setPreparing(true);setNotice(null);
  try{
   await beforeCommand();
   if(confirm.hasOtherProtectedCommands())return;
   const fresh=await query.refetch();
   if(!fresh.isSuccess||!fresh.data){setNotice({kind:'sourceChanged'});return;}
   const latest=fresh.data;
   const rows=attendanceRows(latest).map(row=>{const change=changes.find(item=>item.id===row.contributionId);return change?{...row,selected:true,attendance:change.row.attendance,minutes:change.row.minutes,reason:change.row.reason,void:change.row.void}:row;});
   const parsed=attendanceInput(latest,rows);
   if(!parsed.success){setNotice({kind:'invalidAttendance'});return;}
   confirm.mutate({taskId:task.id,input:parsed.data},{onSuccess:()=>{onDone?.();}});
  }catch{setNotice({kind:'ordinaryUnresolved'});}finally{setPreparing(false);}
 };
 const forget=(id:string)=>setPending(before=>{const{[id]:old,...rest}=before;void old;return rest;});
 const patchPending=(source:SharedActivityContributionDto,patch:Partial<PendingRow>)=>setPending(before=>{const base:PendingRow=before[source.id]??{attendance:source.attendance,minutes:source.minutes===null?'':String(source.minutes),reason:'',void:false};return{...before,[source.id]:{...base,...patch}};});
 const choose=(source:SharedActivityContributionDto,value:string)=>{
  const attendance:Attendance=value==='present'||value==='partial'||value==='absent'?value:'unconfirmed';
  if(attendance===source.attendance&&source.postingState!=='void'){forget(source.id);return;}
  if(attendance==='partial'||isCorrection(source)){patchPending(source,{attendance,void:false});return;}
  if(attendance==='unconfirmed')return;
  void commitAttendance([{id:source.id,row:{attendance,minutes:'',reason:'',void:false}}],()=>forget(source.id));
 };
 /** Saves a held change as soon as it is complete: on leaving the minutes or reason field, or Enter. */
 const finishPending=(source:SharedActivityContributionDto)=>{
  const row=pending[source.id];if(!row)return;
  const minutesOk=row.attendance!=='partial'||(row.minutes.trim()!==''&&Number.isSafeInteger(Number(row.minutes))&&Number(row.minutes)>=1);
  if(!minutesOk||(isCorrection(source)&&!row.reason.trim()))return;
  void commitAttendance([{id:source.id,row}],()=>forget(source.id));
 };
 const active=record?.contributions.filter(row=>row.rosterActive)??[],known=record?.contributions.filter(row=>row.postingState==='active')??[],knownMinutes=known.reduce((sum,row)=>sum+(row.minutes??0),0),unknown=active.filter(row=>row.postingState==='unconfirmed').length;
 const name=(membershipId:string)=>members.find(member=>member.id===membershipId)?.displayName??t('sharedActivities.formerParticipant');
 const allowedFor=(source:SharedActivityContributionDto)=>record?(source.membershipId===record.permissions.selfMembershipId?record.permissions.canWriteSelf:record.permissions.canWriteOthers):false;
 const listed=record?.contributions.filter(row=>row.rosterActive||row.postingState!=='unconfirmed')??[];
 const everyonePresent=record&&record.actualDurationMinutes!==null?listed.filter(row=>row.rosterActive&&row.postingState==='unconfirmed'&&allowedFor(row)):[];
 const onEnter=(done:()=>void)=>(event:{key:string;preventDefault:()=>void})=>{if(event.key==='Enter'){event.preventDefault();done();}};
 return <section aria-label={t('sharedActivities.title')} className="my-3 space-y-3 rounded-lg border border-line bg-canvas p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('sharedActivities.title')}</h3>{!record&&!setup?<Button size="sm" variant="primary" disabled={disabled||!canConfigure||query.isPending||query.isFetching||query.isError} onClick={()=>void begin()}>{t('sharedActivities.enable')}</Button>:null}</div>
  {query.isPending?<p role="status" className="text-xs text-muted">{t('sharedActivities.loading')}</p>:query.isError?<QueryErrorState error={query.error} subject="task" headingLevel={3} onRetry={()=>void query.refetch()}/>:!record?<p className="text-xs text-muted">{t('sharedActivities.enableHelp')}</p>:<>
   <p className="text-xs text-muted">{t('sharedActivities.savedSummary',{duration:record.actualDurationMinutes===null?'—':String(record.actualDurationMinutes),count:active.length,minutes:knownMinutes,unknown})}</p>
   <p className="text-xs text-muted">{t('sharedActivities.boundFields',{plan:fields.find(field=>field.id===record.activity.planFieldId)?.name??t('sharedActivities.unavailableField'),fact:fields.find(field=>field.id===record.activity.factFieldId)?.name??t('sharedActivities.unavailableField')})}</p>
   <p className="text-xs text-muted">{t('sharedActivities.savedDate',{date:record.activity.occurrenceDate,organizer:name(record.activity.organizerMembershipId)})}</p>
   {record.contributions.some(row=>row.postingState==='active'&&(row.confirmedDurationMinutes!==record.actualDurationMinutes||row.confirmedActivityRevision!==record.activity.revision))?<p role="status" className="text-xs text-muted">{t('sharedActivities.snapshotHelp')}</p>:null}
   <div className="flex flex-wrap gap-3 text-xs">{safeLink(record.activity.recordingUrl)?<a href={safeLink(record.activity.recordingUrl)??undefined} target="_blank" rel="noreferrer" className="text-accent-ink underline">{t('sharedActivities.openRecording')}</a>:null}{safeLink(record.activity.summaryUrl)?<a href={safeLink(record.activity.summaryUrl)??undefined} target="_blank" rel="noreferrer" className="text-accent-ink underline">{t('sharedActivities.openSummary')}</a>:null}</div>
   {record.activity.summaryText?<details><summary className="cursor-pointer text-xs text-muted">{t('sharedActivities.summary')}</summary><p className="mt-1 whitespace-pre-wrap break-words text-sm">{record.activity.summaryText}</p></details>:null}
   {canAttend?<div className="space-y-2" aria-label={t('sharedActivities.attendance')} role="group">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-medium">{t('sharedActivities.attendance')}</p>{everyonePresent.length>0?<Button size="sm" variant="ghost" disabled={disabled} onClick={()=>void commitAttendance(everyonePresent.map(source=>({id:source.id,row:{attendance:'present',minutes:'',reason:'',void:false}})))}>{t('sharedActivities.everyonePresent')}</Button>:null}</div>
    <p className="text-xs text-muted">{t('sharedActivities.confirmHelp')}</p>
    {!record.permissions.canWriteOthers?<p className="text-xs text-muted">{t('sharedActivities.selfOnly')}</p>:null}
    <div className="max-h-96 space-y-2 overflow-y-auto">{listed.map(source=>{
     const allowed=allowedFor(source),row=pending[source.id],correction=isCorrection(source),state=row?.attendance??source.attendance;
     return <div key={source.id} className="space-y-2 rounded border border-line bg-surface p-2" onKeyDown={event=>{if(event.key==='Escape'&&row){event.stopPropagation();forget(source.id);}}}>
      <p className="text-xs font-medium">{name(source.membershipId)}{!source.rosterActive?<span className="ml-2 text-xs font-normal text-muted">{t('sharedActivities.formerParticipant')}</span>:null}</p>
      <p className="text-xs text-muted">{t('sharedActivities.savedContribution',{state:t(source.postingState==='void'?'sharedActivities.void':source.attendance==='unconfirmed'?'sharedActivities.unconfirmed':source.attendance==='present'?'sharedActivities.present':source.attendance==='partial'?'sharedActivities.partial':'sharedActivities.absent'),minutes:source.minutes===null?'—':String(source.minutes)})}</p>
      <ReportSelect label={t('sharedActivities.attendanceFor',{person:name(source.membershipId)})} value={source.postingState==='void'&&!row?'unconfirmed':state} disabled={disabled||!allowed} onChange={value=>choose(source,value)}><option value="unconfirmed">{t('sharedActivities.unconfirmed')}</option><option value="present">{t('sharedActivities.present')}</option><option value="partial">{t('sharedActivities.partial')}</option><option value="absent">{t('sharedActivities.absent')}</option></ReportSelect>
      {row?.attendance==='partial'?<label className="grid gap-1 text-xs text-muted">{t('sharedActivities.personalMinutes')}<TextInput type="number" min={1} max={record.actualDurationMinutes??undefined} value={row.minutes} disabled={disabled||!allowed} onChange={event=>patchPending(source,{minutes:event.target.value})} onBlur={()=>finishPending(source)} onKeyDown={onEnter(()=>finishPending(source))}/></label>:null}
      {correction&&allowed?<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={row?.void??false} disabled={disabled} onChange={event=>patchPending(source,{void:event.target.checked})}/>{t('sharedActivities.voidEntry')}</label>:null}
      {row&&correction?<label className="grid gap-1 text-xs text-muted">{t('sharedActivities.reason')}<TextInput value={row.reason} maxLength={1000} disabled={disabled||!allowed} onChange={event=>patchPending(source,{reason:event.target.value})} onBlur={()=>finishPending(source)} onKeyDown={onEnter(()=>finishPending(source))}/></label>:null}
      {row?<p role="status" className="text-xs text-muted">{t('sharedActivities.finishToSave')}</p>:null}
     </div>;})}</div>
   </div>:null}
   {canConfigure&&shown?<details className="rounded border border-line p-2"><summary className="cursor-pointer text-xs text-muted">{t('sharedActivities.configure')}</summary><div className="mt-2 space-y-2"><SharedActivityFields value={shown} onChange={setEdited} fields={fields} members={members} disabled={disabled||!canConfigure}/><p className="text-xs text-muted">{t('sharedActivities.editDurationHelp')}</p></div></details>:null}
  </>}
  {!record&&setup?<div className="space-y-3"><SharedActivityFields value={setup.configuration} onChange={configuration=>setDraft({setup:{...setup,configuration}})} fields={fields} members={members} disabled={disabled||!canConfigure}/><p className="text-xs text-muted">{t('sharedActivities.editDurationHelp')}</p><div className="flex gap-2"><Button size="sm" disabled={disabled||!canConfigure} onClick={()=>void save()}>{t('sharedActivities.saveConfiguration')}</Button><Button size="sm" variant="ghost" disabled={held} onClick={clearSetup}>{t('sharedActivities.discard')}</Button></div></div>:null}
  {notice?<p role="alert" className="text-xs text-danger">{noticeMessages[notice.kind]}</p>:null}
  {[configure,confirm].map((command,index)=>{const own=(command.uncertain?.variables??command.pendingCommand?.variables)?.taskId===task.id;return <div key={index}><SaveFeedback subject="taskSave" error={command.variables?.taskId===task.id?command.error:null} uncertainError={own?command.uncertain?.error??null:null}/>{own&&command.uncertain?<Button size="sm" disabled={!current||command.pendingCommand!==null||(index===0?!canConfigure:!canAttend)} onClick={()=>{if(index===0)configure.retryUncertain({onSuccess:()=>{setEdited(null);clearSetup();}});else confirm.retryUncertain({onSuccess:()=>setPending({})});}}>{t('sharedActivities.retry')}</Button>:null}</div>;})}
 </section>;
}
