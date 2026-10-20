import { useEffect, useState } from 'react';
import { summaryTemplateContentSchema, type GenericHeaderWidgetDto, type GenericHeaderWidgetGroupDto, type MembershipDto, type PlanningCheckRuleDto, type SummaryTemplateContentDto, type SummaryTemplatePersonDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { ReportSelect } from '../generic-reports/ReportConfigEditor';
import type { SummaryTemplateWorkspace } from './queries';
import { contentNeedsPerson, initialTemplateContent, initialTemplatePerson, sameSummaryGroup, keyedTemplateOverrides } from './model';
import { SummaryTemplateEditor, TemplateParameters } from './SummaryTemplateEditor';
interface Edit {kind:'create'|'update'|'customize'|'bind';name:string;content:SummaryTemplateContentDto;person:SummaryTemplatePersonDto;sourceVersion:string;revision:number;templateId:string;baseline:string}
export function SummaryTemplateControls({controller,group,fields,members,checks,readWidgets,writable,onSaved,onDirtyChange,taskScope,checksReady = true}:{controller:SummaryTemplateWorkspace;group:GenericHeaderWidgetGroupDto;fields:readonly TaskFieldDefinitionDto[];members:readonly MembershipDto[];checks:readonly PlanningCheckRuleDto[];readWidgets:()=>GenericHeaderWidgetDto[]|null;writable:boolean;onSaved:()=>void;onDirtyChange?:(dirty:boolean)=>void;taskScope?:{kind:'selected_person_project';membershipId:string};checksReady?:boolean}){
 const{t}=useTranslation(),{catalog,command,activate}=controller;
 const[edit,setEdit]=useState<Edit|null>(null),[selected,setSelected]=useState(''),[invalid,setInvalid]=useState(false);
 useEffect(()=>activate(),[activate]);
 const data=catalog.isSuccess&&!catalog.isError?catalog.data:undefined,binding=data?.bindings.find(item=>!item.detached&&sameSummaryGroup(item.group,group)),template=data?.templates.find(item=>item.id===binding?.templateId);
 const held=command.pendingCommand!==null||command.uncertain!==null,canWrite=writable&&checksReady&&!held&&catalog.isSuccess&&!catalog.isFetching&&!command.hasOtherProtectedCommands();
 const dirty=edit!==null&&JSON.stringify({name:edit.name,content:edit.content,person:edit.person})!==edit.baseline;
 useProtectedDraft(dirty);
 // The outer Summary dialog owns Escape/X; keep its close decision aware of this nested draft.
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
 const begin=(kind:Edit['kind'])=>{
  if(!data||!canWrite)return;
  const picked=kind==='bind'?data.templates.find(item=>item.id===selected):template;
  const widgets=kind==='create'?readWidgets():null;if(kind==='create'&&widgets===null)return;
  const content=kind==='create'?initialTemplateContent(widgets??[],checks,group,taskScope):picked?kind==='customize'&&binding?{...picked.content,...binding.overrides,widgets:picked.content.widgets.map(item=>binding.overrides.widgets?.find(override=>override.key===item.key)??item),balanceChecks:picked.content.balanceChecks.map(item=>binding.overrides.balanceChecks?.find(override=>override.id===item.id)??item)}:picked.content:null;
  if(!content)return;
  const person=kind==='create'?initialTemplatePerson(widgets??[],group,taskScope):binding?.person??initialTemplatePerson([],group);
  const name=kind==='create'?'':picked?.name??'';
  setEdit({kind,name,content:structuredClone(content),person,sourceVersion:data.sourceVersion,revision:kind==='customize'?binding?.revision??0:picked?.revision??0,templateId:picked?.id??'',baseline:JSON.stringify({name,content,person})});setInvalid(false);
 };
 const saved=()=>{setEdit(null);setInvalid(false);onSaved();};
 const send=()=>{
  if(!edit||!canWrite)return;
  if(!summaryTemplateContentSchema.safeParse(edit.content).success||(edit.kind!=='bind'&&!edit.name.trim())||(edit.kind!=='update'&&contentNeedsPerson(edit.content)&&!edit.person)){setInvalid(true);return;}
  const person=contentNeedsPerson(edit.content)?edit.person:null,expectedSourceVersion=edit.sourceVersion;
  if(edit.kind==='create')command.mutate({action:{kind:'create',input:{expectedSourceVersion,name:edit.name,content:edit.content,bind:{group,person}}}},{onSuccess:saved});
  else if(edit.kind==='update')command.mutate({action:{kind:'update',id:edit.templateId,input:{expectedSourceVersion,expectedRevision:edit.revision,name:edit.name,content:edit.content}}},{onSuccess:saved});
  else if(edit.kind==='bind')command.mutate({action:{kind:'bind',input:{expectedSourceVersion,group,templateId:edit.templateId,expectedTemplateRevision:edit.revision,person,overrides:{}}}},{onSuccess:saved});
  else if(binding&&template){const overrides=keyedTemplateOverrides(template.content,edit.content);if(!overrides){setInvalid(true);return;}command.mutate({action:{kind:'customize',id:binding.id,input:{expectedSourceVersion,expectedRevision:edit.revision,person,overrides}}},{onSuccess:saved});}
 };
 const simple=(kind:'reset'|'detach')=>{if(!binding||!data||!canWrite)return;command.mutate({action:{kind,id:binding.id,input:{expectedRevision:binding.revision,expectedSourceVersion:data.sourceVersion}}},{onSuccess:saved});};
 return <section aria-label={t('summaryTemplates.title')} className="space-y-3 rounded-lg border border-line bg-canvas p-3">
  {catalog.isPending?<p role="status" className="text-xs text-muted">{t('summaryTemplates.loading')}</p>:catalog.isError?<QueryErrorState error={catalog.error} subject="fields" headingLevel={3} onRetry={()=>void catalog.refetch()}/>:null}
  {binding&&template?<><p className="text-sm font-medium">{t('summaryTemplates.uses',{name:template.name})} <span className="text-xs font-normal text-muted">{t('summaryTemplates.version',{version:template.revision})}</span>{Object.keys(binding.overrides).length?<span className="ml-2 rounded border border-line px-1 text-xs">{t('summaryTemplates.localChanges')} ({(binding.overrides.widgets?.length??0)+(binding.overrides.balanceChecks?.length??0)+(binding.overrides.period?1:0)+(binding.overrides.taskScope?1:0)})</span>:null}</p><p className="text-xs text-muted">{t('summaryTemplates.linkHelp')}</p></>:<p className="text-sm font-medium">{t('summaryTemplates.independent')}</p>}
  {!edit?<div className="flex flex-wrap items-end gap-2">{binding?<><Button size="sm" variant="ghost" disabled={!canWrite} onClick={()=>begin('update')}>{t('summaryTemplates.editAll')}</Button><Button size="sm" variant="ghost" disabled={!canWrite} onClick={()=>begin('customize')}>{t('summaryTemplates.customize')}</Button><Button size="sm" variant="ghost" disabled={!canWrite||!Object.keys(binding.overrides).length} onClick={()=>simple('reset')}>{t('summaryTemplates.reset')}</Button><Button size="sm" variant="ghost" disabled={!canWrite} onClick={()=>simple('detach')}>{t('summaryTemplates.detach')}</Button></>:<><Button size="sm" variant="ghost" disabled={!canWrite} onClick={()=>begin('create')}>{t('summaryTemplates.saveAs')}</Button><ReportSelect label={t('summaryTemplates.useTemplate')} value={selected} onChange={setSelected} disabled={!canWrite}><option value="">{t('summaryTemplates.chooseTemplate')}</option>{data?.templates.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</ReportSelect><Button size="sm" variant="ghost" disabled={!canWrite||!selected} onClick={()=>begin('bind')}>{t('summaryTemplates.useTemplate')}</Button></>}</div>:<div className="space-y-3">
   {edit.kind==='create'||edit.kind==='update'?<label className="grid gap-1 text-xs text-muted">{t('summaryTemplates.name')}<TextInput value={edit.name} disabled={!canWrite} maxLength={160} onChange={event=>setEdit({...edit,name:event.target.value})}/></label>:null}
   {edit.kind==='update'?<p role="status" className="rounded border border-line p-2 text-sm">{t('summaryTemplates.affects',{count:data?.bindings.filter(item=>!item.detached&&item.templateId===edit.templateId).length??0,version:edit.revision})}</p>:null}
   {edit.kind!=='update'?<TemplateParameters content={edit.content} person={edit.person} group={group} members={members} disabled={!canWrite} onChange={person=>setEdit({...edit,person})}/>:null}
   {edit.kind==='customize'?<p className="text-xs text-muted">{t('summaryTemplates.localHelp')}</p>:null}
   {edit.kind!=='bind'?<SummaryTemplateEditor local={edit.kind==='customize'} value={edit.content} onChange={content=>setEdit({...edit,content})} fields={fields} disabled={!canWrite}/>:<p className="text-xs text-muted">{t(edit.content.taskScope==='group'?'summaryTemplates.groupTasks':'summaryTemplates.personTasks')}</p>}
   {invalid?<p role="alert" className="text-xs text-danger">{t('summaryTemplates.invalid')}</p>:null}{data&&data.sourceVersion!==edit.sourceVersion?<p role="status" className="text-xs text-muted">{t('summaryTemplates.changed')}</p>:null}
   <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface py-2"><Button size="sm" disabled={!canWrite} onClick={send}>{t(edit.kind==='update'?'summaryTemplates.saveAll':edit.kind==='bind'?'summaryTemplates.apply':'summaryTemplates.save')}</Button><Button size="sm" variant="ghost" disabled={held} onClick={()=>setEdit(null)}>{t('summaryTemplates.cancel')}</Button></div>
  </div>}
  <SaveFeedback subject="fieldValueSave" error={command.error} uncertainError={command.uncertain?.error??null}/>{command.uncertain?<Button size="sm" disabled={!writable||command.pendingCommand!==null} onClick={()=>command.retryUncertain({onSuccess:saved})}>{t('summaryTemplates.retry')}</Button>:null}
 </section>;
}
