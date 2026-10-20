import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@workloom/ui';
import { TriangleAlert } from 'lucide-react';
import type { MembershipDto, PlanningCheckIssueQueryInput, SectionDto, TagDto, TaskDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useWorkspaceReadPresentation } from '../workspace/workspaceReadPresentation';
import { useCurrentReportAccess } from '../generic-reports/queries';
import type { TableTaskGroup } from '../task-table/taskGrouping';
import { createPlanningFieldAdvisory } from './presentation';
import { usePlanningCheckAssessment, usePlanningCheckSettings } from './queries';
import { PlanningChecksEditor } from './PlanningChecksEditor';
import { PlanningCheckGroupSignals } from './PlanningCheckGroupSignals';
import { PlanningCheckIssuesDialog } from './PlanningCheckIssuesDialog';
import type { CheckFocus } from './PlanningCheckRuleForm';

export function useProjectPlanningChecks({actorId,workspaceId,projectId,projectRevision,fields,members,sections,tags,enabled,writable,requestedOpen,requestedFieldId,onOpenTask}:{actorId:string;workspaceId:string;projectId:string;projectRevision:number;fields:readonly TaskFieldDefinitionDto[];members:readonly MembershipDto[];sections:readonly SectionDto[];tags:readonly TagDto[];enabled:boolean;writable:boolean;requestedOpen:boolean;requestedFieldId?:string;onOpenTask:(id:string)=>void}){
 const{t}=useTranslation(),access=useCurrentReportAccess(actorId,workspaceId,projectId),settings=usePlanningCheckSettings(actorId,workspaceId,projectId,enabled);
 const presentation=useWorkspaceReadPresentation(actorId,workspaceId,projectId);
 const canManage=writable&&(access==='owner'||access==='admin');
 const assessment=usePlanningCheckAssessment(actorId,workspaceId,projectId,settings.isSuccess?{expectedSettingsRevision:settings.data.revision}:null,enabled&&settings.isSuccess&&settings.data.config.enabled&&!settings.isFetching,projectRevision);
 const[editor,setEditor]=useState<{key:number;focus?:CheckFocus}|null>(null),[handledRequest,setHandledRequest]=useState(false),[retrying,setRetrying]=useState(false);
 const[review,setReview]=useState<{input:Omit<PlanningCheckIssueQueryInput,'offset'|'limit'>;name:string}|null>(null);
 useEffect(()=>{if(requestedOpen&&!handledRequest&&canManage&&settings.isSuccess&&!settings.isFetching){setHandledRequest(true);setEditor({key:Date.now(),...(requestedFieldId&&fields.some(f=>f.id===requestedFieldId)?{focus:{fieldId:requestedFieldId}}:{})});}},[requestedOpen,handledRequest,canManage,settings.isSuccess,settings.isFetching,requestedFieldId,fields]);
 const open=(focus?:CheckFocus)=>{if(canManage&&settings.isSuccess&&!settings.isFetching)setEditor({key:Date.now(),...(focus?{focus}:{})});};
 // Keep the last confirmed assessment during a same-scope background refresh.
 // Errors, lost authority and changed settings still remove it; never infer results from edited cells.
 const current=enabled&&settings.data?.config.enabled===true&&(access!=='blocked'||presentation)&&settings.isSuccess&&assessment.isSuccess&&assessment.data.workspaceId===workspaceId&&assessment.data.projectId===projectId&&assessment.data.settingsRevision===settings.data.revision?assessment.data:undefined;
 const refresh=async()=>{if(retrying)return;setRetrying(true);try{if(settings.isError){await settings.refetch();return;}if(assessment.error instanceof ApiError&&assessment.error.status===409){const before=settings.data?.revision,next=await settings.refetch();if(next.isSuccess&&next.data.revision===before)await assessment.refetch();}else await assessment.refetch();}finally{setRetrying(false);}};
 const onReview=(ruleId:string)=>{if(access==='blocked'||!current||!settings.data)return;const rule=settings.data.config.rules.find(item=>item.id===ruleId);if(rule)setReview({name:rule.name,input:{expectedSettingsRevision:current.settingsRevision,expectedSourceVersion:current.sourceVersion,ruleId}});};
 const groupValue=(group:TableTaskGroup)=>group.kind==='assignee'?{kind:'assignee' as const,membershipId:group.membershipId}:{kind:'section' as const,sectionId:group.sectionId};
 const renderGroup=(group:TableTaskGroup):ReactNode=><PlanningCheckGroupSignals group={groupValue(group)} assessment={current} config={settings.data?.config} writable={canManage&&settings.isSuccess&&!settings.isFetching} canReview={access!=='blocked'} onConfigure={()=>open({group:groupValue(group)})} onReview={onReview}/>;
 const advisoryFor=useMemo(()=>createPlanningFieldAdvisory(settings.data?.config,current),[settings.data?.config,current]);
 const flagsByTask=useMemo(()=>new Map(current?.taskFlags.map(flag=>[flag.taskId,flag])??[]),[current]);
 const fieldAdvisory=(task:TaskDto,field:TaskFieldDefinitionDto)=>task.projectId===projectId?advisoryFor(task.id,field.id,field.name):null;
 const renderTaskIndicator=(task:TaskDto):ReactNode=>{if(task.projectId!==projectId||!current)return null;const ids=flagsByTask.get(task.id)?.overdueRuleIds??[];const ruleId=ids[0];if(!ruleId)return null;return<button type="button" disabled={access==='blocked'} aria-label={t('planningChecks.overdueTask')} title={t('planningChecks.overdueTask')} className="inline-flex size-5 shrink-0 items-center justify-center rounded text-ink hover:bg-canvas" onClick={()=>onReview(ruleId)}><TriangleAlert size={13} aria-hidden="true"/></button>;};
 const control=enabled?<div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">{canManage?<Button size="sm" variant="ghost" disabled={!settings.isSuccess||settings.isFetching} onClick={()=>open()}>{t('planningChecks.entry')}</Button>:null}{settings.isError||assessment.isError?<p role="alert" className="flex items-center gap-2"><span>{t('planningChecks.readError')}</span><Button size="sm" variant="ghost" disabled={retrying||settings.isFetching||assessment.isFetching} onClick={()=>void refresh()}>{t('planningChecks.retry')}</Button></p>:null}{current?.scope.excludedLinkedTasks?<span title={t('planningChecks.homeScope')}>{t('planningChecks.excludedLinked',{count:current.scope.excludedLinkedTasks})}</span>:null}</div>:null;
 const dialogs=<>{editor&&settings.data?<PlanningChecksEditor writable={canManage} key={editor.key} actorId={actorId} workspaceId={workspaceId} projectId={projectId} settings={settings.data} fields={fields} members={members} sections={sections} tags={tags} focus={editor.focus} onClose={()=>setEditor(null)}/>:null}<PlanningCheckIssuesDialog key={review?`${review.input.ruleId}:${review.input.expectedSourceVersion}`:'closed'} actorId={actorId} workspaceId={workspaceId} projectId={projectId} input={review?.input??null} name={review?.name??''} onClose={()=>setReview(null)} onOpenTask={id=>{setReview(null);onOpenTask(id);}} onRefresh={()=>void refresh()}/></>;
 return{control,dialogs,renderGroup,fieldAdvisory,renderTaskIndicator,configureField:canManage?(fieldId:string)=>open({fieldId}):undefined};
}
