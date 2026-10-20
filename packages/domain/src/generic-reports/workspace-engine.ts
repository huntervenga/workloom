import {calculatePersonalEffort,summarizePersonalEffort} from '../shared-activities/effort.js';
import {effortMeasure,personalEffortComparison} from './effort.js';
import type * as C from '@workloom/contracts';
import {Temporal} from 'temporal-polyfill';
import {DomainError} from '../errors.js';
import {comparison,genericRowMeasures} from './engine.js';
import type {GenericReportSource,GenericSourceTask} from './ports.js';
export interface WorkspaceResolvedSource {binding:C.WorkspaceReportBoundSourceDto;source:GenericReportSource}
function invalid(message:string):never{throw new DomainError('DOMAIN_VALIDATION_FAILED',message);}
// Internal aggregation dimensions only: never stored or exposed as user field identities.
const PLAN='workspace_plan',FACT='workspace_fact';
const types=[{id:PLAN,type:'duration' as const},{id:FACT,type:'duration' as const}];
function config(input:C.WorkspaceReportQueryInput):C.GenericReportConfig{return{projectId:input.sources[0]?.reportId??'',hierarchy:input.hierarchy,measures:[{key:'plan',operation:'sum',fieldId:PLAN},{key:'fact',operation:'sum',fieldId:FACT}],comparison:{planFieldId:PLAN,factFieldId:FACT,completion:input.completion},groupBy:{kind:'none'},filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null}};}
type EffortPair={plan?:C.PersonalEffortContributionDto;fact?:C.PersonalEffortContributionDto};
function summarize(rows:readonly C.GenericReportRowDto[],input:C.WorkspaceReportQueryInput,efforts?:WeakMap<C.GenericReportRowDto,EffortPair>):C.WorkspaceReportSummaryDto{
 const selected=config(input),values=genericRowMeasures(rows,selected,types),plan=values[0],fact=values[1],paired=comparison(rows,selected);
 if(!plan||!fact||!paired)throw Error('Missing workspace measure configuration');
 if(input.attribution==='personal_effort'&&efforts){const planEffort=summarizePersonalEffort(rows.flatMap(row=>{const part=efforts.get(row)?.plan;return part?[part]:[];})),factEffort=summarizePersonalEffort(rows.flatMap(row=>{const part=efforts.get(row)?.fact;return part?[part]:[];}));return{taskCount:new Set(rows.map(row=>row.taskId)).size,plan:effortMeasure('plan',null,planEffort),fact:effortMeasure('fact',null,factEffort),comparison:personalEffortComparison(planEffort,factEffort,rows,{...selected,comparison:{planFieldId:PLAN,factFieldId:FACT,completion:input.completion,attribution:'personal_effort'}})??paired,effort:{plan:planEffort,fact:factEffort}};}
 return{taskCount:rows.length,plan:{...plan,fieldId:null},fact:{...fact,fieldId:null},comparison:paired};
}
function bounds(input:C.WorkspaceReportQueryInput,weekStart:number):{startDate:string;endDate:string}[]{
 const out:{startDate:string;endDate:string}[]=[];let first=Temporal.PlainDate.from(input.range.from);const last=Temporal.PlainDate.from(input.range.to);
 while(Temporal.PlainDate.compare(first,last)<=0){let end=input.bucket==='month'?first.with({day:first.daysInMonth}):first.add({days:(weekStart+6-first.dayOfWeek+7)%7});if(Temporal.PlainDate.compare(end,last)>0)end=last;out.push({startDate:first.toString(),endDate:end.toString()});first=end.add({days:1});}
 return out;
}
export function calculateWorkspaceReport(input:C.WorkspaceReportQueryInput,sources:readonly WorkspaceResolvedSource[],capacity:C.LeaveAvailabilityDto,sourceVersion:string,weekStart=1):C.WorkspaceReportResultDto{
 const allTasks=new Map<string,GenericSourceTask>();for(const item of sources)for(const task of item.source.tasks)allTasks.set(task.id,task);
 if(allTasks.size>5000)invalid('The selected projects exceed 5000 canonical tasks; no partial totals were calculated.');
 const mappings=new Map(sources.map(item=>[item.binding.projectId,item])),peopleIds=new Set(capacity.members.map(member=>member.membershipId));
 const daysByMember=new Map<string,C.LeaveAvailabilityDto['days']>();for(const day of capacity.days){const days=daysByMember.get(day.membershipId)??[];days.push(day);daysByMember.set(day.membershipId,days);}
 const efforts=new WeakMap<C.GenericReportRowDto,EffortPair>();
 const rows:C.GenericReportRowDto[]=[],details:C.WorkspaceReportTaskDto[]=[],categoryMetadata=new Map<string,Omit<C.WorkspaceReportCategoryDto,keyof C.WorkspaceReportSummaryDto>>();
 let missingDateTasks=0,unmappedHomeTasks=0;
 const values=new Map(sources.flatMap(item=>item.source.values.map(value=>[`${value.taskId}:${value.fieldId}`,value] as const)));
 for(const task of [...allTasks.values()].sort((a,b)=>a.id.localeCompare(b.id))){
  if(input.hierarchy==='root_tasks'&&task.parentTaskId!==null)continue;
  if(input.attribution!=='personal_effort'&&(task.responsibleMembershipId===null?input.people.kind!=='all_active':!peopleIds.has(task.responsibleMembershipId)))continue;
  const mapped=mappings.get(task.projectId);if(!mapped){unmappedHomeTasks++;continue;}
  const {binding,source}=mapped;
  const read=(fieldId:string)=>{const value=values.get(`${task.id}:${fieldId}`);return value?.projectId===task.projectId?value:undefined;};
  const dateValue=input.dateSource==='report_date_field'&&binding.dateFieldId?read(binding.dateFieldId):undefined;if(dateValue&&dateValue.value.type!=='date')invalid('A configured date value has an incompatible type.');
  const date=input.dateSource==='due_date'?task.dueDate:dateValue?.value.value;
  if(date===null||date===undefined){missingDateTasks++;continue;}if(typeof date!=='string')invalid('A configured date value has an incompatible type.');if(date<input.range.from||date>input.range.to)continue;
  const cells=[{id:binding.planFieldId,slot:PLAN},{id:binding.factFieldId,slot:FACT}].map(({id,slot}):C.GenericReportCellDto=>{const value=read(id),raw=value?.value.value;if(value&&(value.value.type!=='duration'||(raw!==null&&(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<0))))invalid('A mapped duration value must contain nonnegative whole minutes.');return{fieldId:slot,state:!value?'missing':raw===null?'null':'value',value:typeof raw==='number'?raw:null,valueRevision:value?.revision??null,definitionVersionId:value?.definitionVersionId??null};});
  let categoryKey='uncategorized';if(binding.categoryFieldId){const category=read(binding.categoryFieldId);if(category&&category.value.type!=='single_select')invalid('A category value has an incompatible type.');const optionId=category?.value.value;if(typeof optionId==='string'){const field=source.fields.find(f=>f.id===binding.categoryFieldId),option=field?.options.find(o=>o.id===optionId);if(!option)invalid('A category option is unavailable.');categoryKey=`${binding.projectId}:${binding.categoryFieldId}:${optionId}`;categoryMetadata.set(categoryKey,{key:categoryKey,label:option.name,projectId:binding.projectId,projectName:binding.projectName,fieldId:binding.categoryFieldId,optionId});}}
  if(categoryKey==='uncategorized')categoryMetadata.set(categoryKey,{key:categoryKey,label:'Uncategorized',projectId:null,projectName:null,fieldId:null,optionId:null});
  const row:C.GenericReportRowDto={taskId:task.id,homeProjectId:task.projectId,title:task.title,taskRevision:task.revision,parentTaskId:task.parentTaskId,primaryAssigneeId:task.responsibleMembershipId,statusGroup:task.statusGroup,dueDate:date,groupKey:categoryKey,groupLabel:categoryMetadata.get(categoryKey)?.label??'Uncategorized',placement:'home',values:cells,initialValues:null,cohort:'current',comparison:null,initialComparison:null};
  if(input.attribution==='personal_effort'){
   const scoped={...source,tasks:[task]},planned=calculatePersonalEffort(scoped,{fieldId:binding.planFieldId}),actual=calculatePersonalEffort(scoped,{fieldId:binding.factFieldId});
   const memberKey=(part:C.PersonalEffortContributionDto)=>part.membershipId??'unassigned',plans=new Map(planned.contributions.map(part=>[memberKey(part),part])),facts=new Map(actual.contributions.map(part=>[memberKey(part),part]));
   for(const memberId of new Set([...plans.keys(),...facts.keys()])){
    const p=plans.get(memberId),f=facts.get(memberId),membershipId=(p??f)?.membershipId??null;if(membershipId===null?input.people.kind!=='all_active':!peopleIds.has(membershipId))continue;
    const mapCell=(slot:string,part:C.PersonalEffortContributionDto|undefined):C.GenericReportCellDto=>({fieldId:slot,state:part?.state==='value'?'value':part?.state==='null'?'null':'missing',value:part?.state==='value'?part.minutes:null,valueRevision:part?.sourceRevision??null,definitionVersionId:null});
    let contributionCategory=categoryKey;
    if(f?.sourceKind==='shared_attendance'&&binding.categoryFieldId){const captured=f.category;if(!captured||captured.fieldId!==binding.categoryFieldId){contributionCategory='category_not_captured';categoryMetadata.set(contributionCategory,{key:contributionCategory,label:'Category not captured',projectId:null,projectName:null,fieldId:null,optionId:null});}else{contributionCategory=captured.optionId?`${binding.projectId}:${captured.fieldId}:${captured.optionId}`:'uncategorized';categoryMetadata.set(contributionCategory,{key:contributionCategory,label:captured.label??'Uncategorized',projectId:captured.optionId?binding.projectId:null,projectName:captured.optionId?binding.projectName:null,fieldId:captured.fieldId,optionId:captured.optionId,color:captured.color});}}
    const expanded={...row,primaryAssigneeId:membershipId,values:[mapCell(PLAN,p),mapCell(FACT,f)],groupKey:contributionCategory,groupLabel:categoryMetadata.get(contributionCategory)?.label??'Uncategorized'};rows.push(expanded);efforts.set(expanded,{...(p?{plan:p}:{}),...(f?{fact:f}:{})});
    details.push({taskId:task.id,homeProjectId:task.projectId,title:task.title,primaryAssigneeId:task.responsibleMembershipId,attributionMembershipId:membershipId,sourceKey:(p??f)?.sourceKey??task.id,date,statusGroup:task.statusGroup,planState:p?.state==='value'?'value':p?.state==='null'?'null':'missing',factState:f?.state==='value'?'value':f?.state==='null'?'null':'missing',planMinutes:p?.minutes??null,factMinutes:f?.minutes??null,categoryKey:contributionCategory});
   }
   if(rows.length>50000)invalid('The full workspace effort scope exceeds50000 contributions; no partial total was calculated.');continue;
  }
  rows.push(row);
  const plan=cells[0],fact=cells[1];if(!plan||!fact)throw Error('Missing normalized values');
  details.push({taskId:task.id,homeProjectId:task.projectId,title:task.title,primaryAssigneeId:task.responsibleMembershipId,date,statusGroup:task.statusGroup,planState:plan.state==='value'?'value':plan.state==='null'?'null':'missing',factState:fact.state==='value'?'value':fact.state==='null'?'null':'missing',planMinutes:plan.value,factMinutes:fact.value,categoryKey});
 }
 function categories(selected:readonly C.GenericReportRowDto[]):C.WorkspaceReportCategoryDto[]{const groups=new Map<string,C.GenericReportRowDto[]>();for(const row of selected){const group=groups.get(row.groupKey)??[];group.push(row);groups.set(row.groupKey,group);}return[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,group])=>{const metadata=categoryMetadata.get(key);if(!metadata)throw Error('Missing category metadata');return{...metadata,...summarize(group,input,efforts)};});}
 function members(selected:readonly C.GenericReportRowDto[],startDate:string,endDate:string):C.WorkspaceReportPersonDto[]{
  const list:C.WorkspaceReportPersonDto[]=capacity.members.map(member=>{const group=selected.filter(row=>row.primaryAssigneeId===member.membershipId),days=(daysByMember.get(member.membershipId)??[]).filter(day=>day.date>=startDate&&day.date<=endDate);const sum=(key:'scheduledMinutes'|'holidayMinutes'|'absenceMinutes'|'availableMinutes')=>member.scheduleKnown?days.reduce((total,day)=>total+day[key],0):null;return{membershipId:member.membershipId,displayName:member.displayName,...summarize(group,input,efforts),capacity:{...member,scheduledMinutes:sum('scheduledMinutes'),holidayMinutes:sum('holidayMinutes'),absenceMinutes:sum('absenceMinutes'),availableMinutes:sum('availableMinutes')},categories:categories(group)};});
  const unassigned=selected.filter(row=>row.primaryAssigneeId===null);if(unassigned.length)list.push({membershipId:null,displayName:'Unassigned',...summarize(unassigned,input,efforts),capacity:null,categories:categories(unassigned)});return list;
 }
 const buckets=bounds(input,weekStart).map(bound=>{const group=rows.filter(row=>row.dueDate!==null&&row.dueDate>=bound.startDate&&row.dueDate<=bound.endDate),days=capacity.days.filter(day=>day.date>=bound.startDate&&day.date<=bound.endDate),unknown=capacity.members.filter(member=>!member.scheduleKnown).length;const sum=(key:'scheduledMinutes'|'holidayMinutes'|'absenceMinutes'|'availableMinutes')=>unknown?null:days.reduce((total,day)=>total+day[key],0);return{...bound,...summarize(group,input,efforts),capacity:{scheduledMinutes:sum('scheduledMinutes'),holidayMinutes:sum('holidayMinutes'),absenceMinutes:sum('absenceMinutes'),availableMinutes:sum('availableMinutes'),unconfiguredMembers:unknown},people:members(group,bound.startDate,bound.endDate)};});
 return{sourceVersion,scope:'selected_projects_canonical_tasks',filterSemantics:'bindings_only',attribution:input.attribution==='personal_effort'?'personal_effort':'primary_assignee',dateSemantics:'current_task_cohort',range:input.range,bucket:input.bucket,dateSource:input.dateSource,hierarchy:input.hierarchy,completion:input.completion,sources:sources.map(item=>item.binding),summary:summarize(rows,input,efforts),people:members(rows,input.range.from,input.range.to),categories:categories(rows),buckets,capacity,missingDateTasks,unmappedHomeTasks,rows:details};
}
