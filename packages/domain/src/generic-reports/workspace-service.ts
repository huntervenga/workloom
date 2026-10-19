import * as C from '@workloom/contracts';
import {Temporal} from 'temporal-polyfill';
import {roleHasCapability} from '../access/capabilities.js';
import {DomainError,notFoundError} from '../errors.js';
import {canonicalJson} from '../tasks/service.js';
import {validateGenericConfig} from './engine.js';
import {calculateWorkspaceReport,type WorkspaceResolvedSource} from './workspace-engine.js';
import type {GenericReportScope} from './ports.js';
function invalid(message:string):never{throw new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function required<T>(value:T|undefined):T{if(value===undefined)throw Error('Workspace reporting repository is unavailable.');return value;}
function numericConfig(report:C.GenericReportDefinitionDto,categoryFieldId:string|null,dateSource:C.WorkspaceReportQueryInput['dateSource'],input?:C.WorkspaceReportQueryInput):C.GenericReportConfig{
 const compare=report.config.comparison;if(!compare)invalid('Choose a report with ordinary duration plan and actual fields.');
 const oldDate=report.config.filters.dateRange?.source;
 if(dateSource==='report_date_field'&&oldDate?.kind!=='field')invalid('This report has no configured custom date field. Use due dates or configure its date binding.');
 return{projectId:report.projectId,hierarchy:input?.hierarchy??'all_tasks',measures:[{key:'plan',operation:'sum',fieldId:compare.planFieldId},{key:'fact',operation:'sum',fieldId:compare.factFieldId}],comparison:{...compare,completion:input?.completion??'done_only'},groupBy:categoryFieldId?{kind:'category',fieldId:categoryFieldId}:{kind:'none'},filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:input?{source:dateSource==='report_date_field'&&oldDate?.kind==='field'?oldDate:{kind:'due_date'},from:input.range.from,to:input.range.to}:null}};
}
export async function workspaceReportSources(scope:GenericReportScope):Promise<C.WorkspaceReportSourcesDto>{
 const catalog=await required(scope.reports.workspaceCatalog).call(scope.reports),members=await required(scope.reports.workspaceMembers).call(scope.reports);
 const sources=catalog.filter(source=>{if(source.report.archivedAt!==null||!source.report.config.comparison)return false;try{validateGenericConfig(numericConfig(source.report,null,'due_date'),source.fields);return true;}catch(error){if(error instanceof DomainError&&error.code==='DOMAIN_VALIDATION_FAILED')return false;throw error;}});
 const timezone=scope.access.workspace.timezone,today=Temporal.Instant.fromEpochMilliseconds(scope.barrierAt.getTime()).toZonedDateTimeISO(timezone).toPlainDate().toString();
 return C.workspaceReportSourcesSchema.parse({today,timezone,sources,members});
}
export async function queryWorkspaceReport(scope:GenericReportScope,input:C.WorkspaceReportQueryInput,digest:(text:string)=>string):Promise<C.WorkspaceReportResultDto>{
 const selected:WorkspaceResolvedSource[]=[],seenProjects=new Set<string>();
 // All reads occur under one authorized shared workspace barrier; no receipts or snapshots are written.
 for(const reference of input.sources){
  const report=await scope.reports.find(reference.reportId);if(!report||report.workspaceId!==scope.context.workspaceId)throw notFoundError();
  const project=await scope.repository.tasks.findProject(scope.context.workspaceId,report.projectId);if(!project||project.archivedAt!==null||report.archivedAt!==null)throw notFoundError();
  if(report.revision!==reference.expectedRevision)throw new DomainError('REVISION_CONFLICT','A source report changed. Reload workspace report sources.',{details:{currentRevision:report.revision}});
  if(seenProjects.has(report.projectId))invalid('Choose exactly one plan/actual mapping per home project.');seenProjects.add(report.projectId);
  const categoryFieldId=reference.categoryFieldId===undefined?(report.config.groupBy.kind==='category'?report.config.groupBy.fieldId:null):reference.categoryFieldId;
  const config=numericConfig(report,categoryFieldId,input.dateSource,input),source=await scope.reports.source(config);validateGenericConfig(config,source.fields);
  const find=(id:string)=>{const field=source.fields.find(field=>field.id===id);if(!field)invalid('A source field is unavailable.');return field;};
  const comparison=config.comparison;if(!comparison)throw Error('Missing validated comparison');
  const dateFieldId=config.filters.dateRange?.source.kind==='field'?config.filters.dateRange.source.fieldId:null;
  selected.push({binding:{projectId:report.projectId,projectName:project.name,reportId:report.id,reportName:report.name,revision:report.revision,planFieldId:comparison.planFieldId,planFieldName:find(comparison.planFieldId).name,factFieldId:comparison.factFieldId,factFieldName:find(comparison.factFieldId).name,categoryFieldId,categoryFieldName:categoryFieldId?find(categoryFieldId).name:null,dateFieldId,dateFieldName:dateFieldId?find(dateFieldId).name:null},source});
 }
 const capacity=await required(scope.reports.workspaceCapacity).call(scope.reports,{startDate:input.range.from,endDate:input.range.to,people:input.people},roleHasCapability(scope.access.membership.role,'leave.manage'));
 const {expectedSourceVersion:expected,...configuration}=input;
 const sourceVersion=digest(canonicalJson({configuration,selected,capacity,weekStart:scope.access.workspace.weekStart}));
 if(expected&&sourceVersion!==expected)throw new DomainError('PREVIEW_STALE','The workspace report source changed. Reload the complete dashboard.');
 return C.workspaceReportResultSchema.parse(calculateWorkspaceReport(input,selected,capacity,sourceVersion,scope.access.workspace.weekStart));
}
