import type * as C from '@workloom/contracts';
import {Temporal} from 'temporal-polyfill';
import {DomainError,notFoundError} from '../errors.js';
import {roleHasCapability} from '../access/capabilities.js';
import {canonicalJson} from '../tasks/service.js';
import {calculateGenericReport,usedFieldIds,validateGenericConfig} from './engine.js';
import type {GenericReportScope,GenericReportSource,GenericSourceTask} from './ports.js';
function invalid(message:string):never{throw new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function required<T>(value:T|undefined):T{if(value===undefined)throw Error('Missing header widget repository port.');return value;}
export function resolveHeaderRange(scope:Pick<GenericReportScope,'barrierAt'|'access'>,range:Extract<C.GenericHeaderWidgetDto,{kind:'capacity'}>['range'],project?:C.ProjectDto):{from:string;to:string}|null{
 if(range.kind==='project_dates'){const dates=project?.dateRange;if(!dates)return null;const days=(Date.parse(dates.to+'T00:00:00Z')-Date.parse(dates.from+'T00:00:00Z'))/86400000+1;return days>=1&&days<=366?dates:null;}
 if(range.kind==='dates')return{from:range.from,to:range.to};
 const today=Temporal.Instant.fromEpochMilliseconds(scope.barrierAt.getTime()).toZonedDateTimeISO(scope.access.workspace.timezone).toPlainDate(),start=today.subtract({days:(today.dayOfWeek-scope.access.workspace.weekStart+7)%7});return{from:start.toString(),to:start.add({days:6}).toString()};
}
const baseConfig=(projectId:string,input:Pick<C.QueryGenericHeaderWidgetsInput,'hierarchy'|'filters'>):C.GenericReportConfig=>({projectId,hierarchy:input.hierarchy,filters:input.filters,comparison:null,groupBy:{kind:'none'},measures:[{key:'tasks',operation:'count_tasks'}]});
const capacityKey=(membershipId:string,range:{from:string;to:string})=>membershipId+':'+range.from+':'+range.to;
function capacityLimits(rules:readonly C.GenericHeaderWidgetRuleDto[],scope:GenericReportScope,project?:C.ProjectDto){const fields=new Set(rules.flatMap(rule=>rule.widgets.flatMap(widget=>widget.kind==='measure'&&widget.measure.operation!=='count_tasks'?[widget.measure.fieldId]:[])));if(fields.size>12)invalid('Header widgets support at most 12 distinct metric fields.');const sources=new Set<string>(),members=new Set<string>();for(const rule of rules)for(const widget of rule.widgets)if(widget.kind==='capacity'){members.add(widget.membershipId);const range=resolveHeaderRange(scope,widget.range,project);sources.add(range?capacityKey(widget.membershipId,range):widget.membershipId+':project_dates');}if(sources.size>100||members.size>100)invalid('Header widgets support at most 100 distinct capacity sources and people.');}
function configWithCapacity(projectId:string,membershipId:string,range:{from:string;to:string}):C.GenericReportConfig{return{...baseConfig(projectId,{hierarchy:'all_tasks',filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null}}),capacity:{startDate:range.from,endDate:range.to,people:{kind:'selected',membershipIds:[membershipId]}}};}
async function validateMember(scope:GenericReportScope,projectId:string,membershipId:string,range:{from:string;to:string},manager:boolean){try{await required(scope.reports.validateCapacity).call(scope.reports,configWithCapacity(projectId,membershipId,range),manager);}catch(error){if(error instanceof DomainError&&(error.code==='NOT_FOUND'||error.code==='DOMAIN_VALIDATION_FAILED'))throw notFoundError();throw error;}}
export async function validateHeaderWidgets(scope:GenericReportScope,projectId:string,rules:readonly C.GenericHeaderWidgetRuleDto[],fields:readonly C.TaskFieldDefinitionDto[]):Promise<void>{
 const project=await scope.repository.tasks.findProject(scope.context.workspaceId,projectId);if(!project)throw notFoundError();capacityLimits(rules,scope,project);const manager=roleHasCapability(scope.access.membership.role,'leave.manage'),validated=new Set<string>();
 for(const rule of rules){
  if(rule.group.kind==='section'&&rule.group.sectionId!==null){const section=await scope.repository.tasks.findSection(scope.context.workspaceId,rule.group.sectionId);if(!section||section.projectId!==projectId||section.archivedAt!==null)throw notFoundError();}
  if(rule.group.kind==='assignee'&&rule.group.membershipId!==null&&!validated.has(rule.group.membershipId)){const today=Temporal.Instant.fromEpochMilliseconds(scope.barrierAt.getTime()).toZonedDateTimeISO(scope.access.workspace.timezone).toPlainDate().toString();await validateMember(scope,projectId,rule.group.membershipId,{from:today,to:today},manager);validated.add(rule.group.membershipId);}
  for(const widget of rule.widgets){if(widget.kind==='measure')validateGenericConfig({...baseConfig(projectId,{hierarchy:'all_tasks',filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null}}),measures:[widget.measure]},fields);else if(!validated.has(widget.membershipId)){await validateMember(scope,projectId,widget.membershipId,resolveHeaderRange(scope,widget.range,project)??resolveHeaderRange(scope,{kind:'this_week'}) as {from:string;to:string},manager);validated.add(widget.membershipId);}}
 }
}
function matches(task:GenericSourceTask,group:C.GenericHeaderWidgetGroupDto):boolean{return group.kind==='section'?task.sectionId===group.sectionId:task.responsibleMembershipId===group.membershipId;}
export async function queryHeaderWidgets(scope:GenericReportScope,projectId:string,input:C.QueryGenericHeaderWidgetsInput,digest:(text:string)=>string):Promise<C.GenericHeaderWidgetsResultDto>{
 const project=await scope.repository.tasks.findProject(scope.context.workspaceId,projectId);if(!project)throw notFoundError();
 const settings=await scope.reports.settings(projectId);if(settings.revision!==input.expectedSettingsRevision)throw new DomainError('REVISION_CONFLICT','Reload the current header widget settings.',{details:{currentRevision:settings.revision}});
 const rules=(settings.headerWidgets??[]).filter(rule=>rule.group.kind===input.groupBy);capacityLimits(rules,scope,project);
 const config=baseConfig(projectId,input),extra=[...new Set(rules.flatMap(rule=>rule.widgets.flatMap(widget=>widget.kind==='measure'&&widget.measure.operation!=='count_tasks'?[widget.measure.fieldId]:[])))];
 const source=await scope.reports.source(config,extra);validateGenericConfig(config,source.fields);
 const manager=roleHasCapability(scope.access.membership.role,'leave.manage'),requests=new Map<string,C.LeaveAvailabilityInput>(),unavailable=new Set<string>();
 for(const rule of rules)for(const widget of rule.widgets)if(widget.kind==='capacity'){
  const range=resolveHeaderRange(scope,widget.range,project);if(!range)continue;const key=capacityKey(widget.membershipId,range);if(requests.has(key)||unavailable.has(key))continue;
  try{await validateMember(scope,projectId,widget.membershipId,range,manager);requests.set(key,{startDate:range.from,endDate:range.to,people:{kind:'selected',membershipIds:[widget.membershipId]}});}catch(error){if(error instanceof DomainError&&error.code==='NOT_FOUND')unavailable.add(key);else throw error;}
 }
 const capacityResults=requests.size?await required(scope.reports.workspaceCapacities).call(scope.reports,[...requests.values()],manager):[],capacity=new Map([...requests.keys()].map((key,index)=>[key,capacityResults[index]]));
 const valuesByTask=new Map<string,C.TaskFieldValueDto[]>();for(const value of source.values){const values=valuesByTask.get(value.taskId)??[];values.push(value);valuesByTask.set(value.taskId,values);}
 const groups:C.GenericHeaderWidgetsResultDto['groups']=[];
 for(const rule of rules){
  const group=rule.group;let groupAvailable=true;if(group.kind==='section'&&group.sectionId!==null){const section=await scope.repository.tasks.findSection(scope.context.workspaceId,group.sectionId);groupAvailable=!!section&&section.projectId===projectId&&section.archivedAt===null;}else if(group.kind==='assignee'&&group.membershipId!==null)groupAvailable=Object.hasOwn(source.memberLabels,group.membershipId);
  const tasks=source.tasks.filter(task=>matches(task,group)),measureWidgets=rule.widgets.filter(widget=>widget.kind==='measure');
  const validMeasures=measureWidgets.filter(widget=>{try{validateGenericConfig({...config,measures:[widget.measure]},source.fields);return true;}catch(error){if(error instanceof DomainError&&error.code==='DOMAIN_VALIDATION_FAILED')return false;throw error;}});
  let measures:C.GenericMeasureResultDto[]=[];
  if(groupAvailable&&validMeasures.length){const selected={...config,measures:validMeasures.map(widget=>({...widget.measure,key:widget.key}))},ids=new Set(usedFieldIds(selected));const subset:GenericReportSource={...source,tasks,values:tasks.flatMap(task=>(valuesByTask.get(task.id)??[]).filter(value=>ids.has(value.fieldId)))};measures=calculateGenericReport(subset,selected,'0'.repeat(64),null,0,1).measures;}
  groups.push({group,widgets:rule.widgets.map(widget=>{
   const label=widget.label===undefined?{}:{label:widget.label};
   if(widget.kind==='measure'){const result=measures.find(measure=>measure.key===widget.key)??null;return{key:widget.key,...label,kind:'measure',result,unavailableReason:!groupAvailable?'group_unavailable':result===null?'field_unavailable':null};}
   const range=resolveHeaderRange(scope,widget.range,project),person=range?capacity.get(capacityKey(widget.membershipId,range))?.members.find(member=>member.membershipId===widget.membershipId)??null:null,unavailableReason=!groupAvailable?'group_unavailable':range===null?project.dateRange?'project_dates_too_long':'project_dates_missing':person===null?'member_unavailable':!person.scheduleKnown&&widget.override===undefined?'schedule_unknown':null;
   const computedAvailableMinutes=groupAvailable?person?.availableMinutes??null:null,displayAvailableMinutes=unavailableReason===null?(widget.override?.minutes??computedAvailableMinutes):null;
   return{key:widget.key,...label,kind:'capacity',membershipId:widget.membershipId,range,person:groupAvailable?person:null,computedAvailableMinutes,displayAvailableMinutes,manualOverride:widget.override!==undefined,...(widget.override?.note===undefined?{}:{overrideNote:widget.override.note}),unavailableReason};
  })});
 }
 const stableSource={...source,fields:[...source.fields].sort((a,b)=>a.id.localeCompare(b.id)),tasks:source.tasks.map(task=>({...task,tagIds:[...task.tagIds].sort()})).sort((a,b)=>a.id.localeCompare(b.id)),values:[...source.values].sort((a,b)=>a.taskId.localeCompare(b.taskId)||a.fieldId.localeCompare(b.fieldId))};
 const stableCapacity=[...capacity.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,result])=>result?{key,startDate:result.startDate,endDate:result.endDate,settingsConfigured:result.settingsConfigured,settingsRevision:result.inputVersions.settingsRevision,members:[...result.members].sort((a,b)=>a.membershipId.localeCompare(b.membershipId)),days:[...result.days].sort((a,b)=>a.membershipId.localeCompare(b.membershipId)||a.date.localeCompare(b.date)),intervals:[...result.intervals].sort((a,b)=>a.membershipId.localeCompare(b.membershipId)||a.startDate.localeCompare(b.startDate)||a.endDate.localeCompare(b.endDate)),companyHolidays:[...result.companyHolidays].sort()}:null);
 const sourceVersion=digest(canonicalJson({project:{id:project.id,revision:project.revision,dateRange:project.dateRange??null},settings,input:{groupBy:input.groupBy,hierarchy:input.hierarchy,filters:input.filters},source:stableSource,capacity:stableCapacity,groups}));if(input.expectedSourceVersion&&input.expectedSourceVersion!==sourceVersion)throw new DomainError('PREVIEW_STALE','Header widget sources changed. Reload the current table totals.');
 return{projectId,settingsRevision:settings.revision,sourceVersion,groupBy:input.groupBy,hierarchy:input.hierarchy,filters:input.filters,groups};
}
