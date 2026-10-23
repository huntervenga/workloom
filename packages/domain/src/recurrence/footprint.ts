import {DomainError,notFoundError} from '../errors.js';
import type {PlanningMutationIntent,PlanningRepository} from '../planning/ports.js';
import type {RecurrenceAffectedFootprint,RecurrenceGuardIntent,RecurrenceRepository} from './ports.js';

/** Exhaustive typed footprint matrix (docs16 §8): the exact source projects an intent may change.
 * Internal signature: resolveRecurrenceAffectedProjects(scope:{context,repository,recurrence},intent):Promise<RecurrenceAffectedFootprint>.
 * A malformed target/input shape is never guessed — it throws (unexpected → whole tx rolls back). A well-formed
 * target that does not exist yields 'none'; its handler then answers 404 and nothing commits.
 */
export interface RecurrenceFootprintScope {
 readonly context:{readonly workspaceId:string};readonly repository:PlanningRepository;readonly recurrence:RecurrenceRepository;
}
const none:RecurrenceAffectedFootprint={kind:'none'};
function projects(...ids:(string|null|undefined)[]):RecurrenceAffectedFootprint {
 const list=[...new Set(ids.filter((id):id is string=>typeof id==='string'))].sort();return list.length?{kind:'projects',projectIds:list}:none;
}
function record(value:unknown,what:string):Record<string,unknown> {if(typeof value!=='object'||value===null)throw new Error(`Unknown recurrence footprint: ${what} is not an object.`);return value as Record<string,unknown>;}
function text(value:unknown,what:string):string {if(typeof value!=='string')throw new Error(`Unknown recurrence footprint: ${what} is not an ID.`);return value;}
function never(value:never):never {throw new Error(`Unhandled recurrence footprint intent: ${String(value)}`);}

export async function resolveRecurrenceAffectedProjects(scope:RecurrenceFootprintScope,intent:RecurrenceGuardIntent):Promise<RecurrenceAffectedFootprint> {
 const repo=scope.repository,ws=scope.context.workspaceId,i=intent as PlanningMutationIntent;
 const taskProject=async(id:string)=>(await repo.tasks.findTask(ws,id))?.projectId;
 const periodProject=async(id:string)=>(await repo.findPeriod(ws,id))?.projectId;
 const fieldProject=async(id:string)=>(await repo.fields.findField(ws,id))?.projectId;
 const seriesProject=async(id:string)=>(await scope.recurrence.findSeries(ws,id))?.projectId;
 const meetingProject=async(taskId:string)=>(await repo.findMeetingByTask(ws,taskId))?.projectId??await taskProject(taskId);
 // Broad sources (a workspace tag) include every project and period owner: fail closed, never narrowed by guess.
 const allProjects=async()=>projects(...(await repo.tasks.listProjects(ws)).map(p=>p.id),...(await repo.listPeriods(ws)).map(p=>p.projectId));
 switch(i.family){
  case 'shared_activity':
   switch(i.command){
    case 'shared_activity.create':return projects(i.target.projectId??undefined);
    case 'shared_activity.configure':case 'shared_activity.attendance':return projects(i.target.taskId?await taskProject(i.target.taskId):undefined);
    default:return never(i);
   }
  case 'comment':case 'table_preference':case 'cutoff':case 'generic_report':case 'planning_check':case 'task_defaults':case 'project_rules':case 'summary_template':return none;
  case 'task_placement':
   switch(i.command){
    case 'task.project.attach':case 'task.project.update':case 'task.project.detach':case 'task.project.restore':return projects(await taskProject(i.target.taskId),(await repo.tasks.findProject(ws,i.target.projectId))?.id);
    default:return never(i);
   }
  case 'import':return i.command==='import.csv.stage'?none:projects(i.target.projectId);
  case 'duplication':return projects((await repo.tasks.findProject(ws,i.target.projectId))?.id);
  case 'schedule':return projects(i.target.projectId,...i.target.affectedProjectIds);
  case 'task':
   switch(i.command){
    case 'project.create':case 'tag.create':return none;
    case 'project.update':case 'section.create':return projects((await repo.tasks.findProject(ws,text(i.target,'project')))?.id);
    case 'section.update':return projects((await repo.tasks.findSection(ws,text(i.target,'section')))?.projectId);
    case 'tag.update':return allProjects();
    case 'task.create':return projects((await repo.tasks.findProject(ws,text(record(i.input,'task input')['projectId'],'task project')))?.id);
    case 'task.update':case 'task.archive':case 'task.restore':case 'task.move':return projects(await taskProject(text(i.target,'task')));
    default:return never(i);
   }
  case 'task_bulk':{
   if(i.target.projectId!==i.input.projectId)throw new Error('Unknown recurrence footprint: bulk target and input project differ.');
   const projectId=(await repo.tasks.findProject(ws,i.target.projectId))?.id;
   if(!projectId)return none;
   for(const row of i.input.tasks){
    const task=await repo.tasks.findTask(ws,row.taskId);
    if(!task)throw notFoundError();
    if(task.projectId!==projectId)throw new DomainError('DOMAIN_VALIDATION_FAILED','The task belongs to another project.');
   }
   return projects(projectId);
  }
  case 'task_row':{
   // The target is composed from the same parsed input; a mismatch is a wiring defect, never user input.
   if(i.target.projectId!==i.input.task.projectId)throw new Error('Unknown recurrence footprint: task row target and input project differ.');
   const projectId=(await repo.tasks.findProject(ws,i.input.task.projectId))?.id;
   if(!projectId)return none;
   // The service preflights these too; the typed boundary still fails closed before any census or freeze.
   // The new task, its values and its package do not exist yet, so the explicit periods are the only other sources.
   for(const ref of [i.input.plan,i.input.actual]){
    if(!ref)continue;
    const period=await repo.findPeriod(ws,ref.periodId);
    if(!period)throw notFoundError();
    if(period.projectId!==projectId)throw new DomainError('DOMAIN_VALIDATION_FAILED','The period belongs to another project.');
   }
   return projects(projectId);
  }
  case 'field':
   switch(i.command){
    case 'field.create':return projects((await repo.tasks.findProject(ws,text(record(i.input,'field input')['projectId'],'field project')))?.id);
    case 'field.policy.set':{const t=record(i.target,'policy target');return projects(await fieldProject(text(t['fieldId'],'field')));}
    case 'field.update':case 'field.option.create':return projects(await fieldProject(text(i.target,'field')));
    case 'field.option.update':return projects(await fieldProject(text(record(i.target,'option target')['fieldId'],'field')));
    case 'field.columns.update':return projects((await repo.tasks.findProject(ws,text(i.target,'project')))?.id);
    case 'field.value.set':case 'field.value.exception':{
     const t=record(i.target,'value target'),taskId=text(t['taskId'],'task'),fieldId=text(t['fieldId'],'field');
     const task=await repo.tasks.findTask(ws,taskId),field=await repo.fields.findField(ws,fieldId);
     if(task&&field&&task.projectId!==field.projectId&&!await repo.fields.hasActivePlacement(ws,taskId,field.projectId))
      throw new DomainError('DOMAIN_VALIDATION_FAILED','The task belongs to another project without an active placement.');
     return projects(task?.projectId,field?.projectId);
    }
    default:return never(i);
   }
  case 'planning':
   switch(i.command){
    case 'period.create':return projects((await repo.tasks.findProject(ws,text(record(i.input,'period input')['projectId'],'period project')))?.id);
    case 'period.update':case 'commitment.create':case 'commitment.update':case 'plan.freeze':return projects(await periodProject(text(record(i.target,'period target')['periodId'],'period')));
    case 'work.set':{const t=record(i.target,'work target');return projects(await periodProject(text(t['periodId'],'period')),await taskProject(text(t['taskId'],'task')));}
    case 'report.create':return projects((await repo.findBaseline(ws,text(record(i.target,'report target')['baselineId'],'baseline')))?.projectId);
    default:return never(i);
   }
  case 'meeting':
   switch(i.command){
    case 'meeting.create':return projects((await repo.tasks.findProject(ws,text(record(i.target,'meeting target')['projectId'],'project')))?.id);
    case 'meeting.update':case 'meeting.attendance.confirm':case 'meeting.plan.apply':return projects(await meetingProject(text(record(i.target,'meeting target')['taskId'],'meeting task')));
    default:return never(i);
   }
  case 'category':
   switch(i.command){
    case 'category.binding.update':return projects((await repo.tasks.findProject(ws,text(record(i.target,'binding target')['projectId'],'project')))?.id);
    case 'work.recategorize':{
     const id=text(record(i.target,'work target')['workLogId'],'work log');
     for(const period of await repo.listPeriods(ws)){const log=(await repo.listRecordedWork(ws,period.id)).find(w=>w.id===id);if(log)return projects(log.projectId);}
     return none;
    }
    case 'work_type_report.create':return projects(await periodProject(text(record(i.target,'report target')['periodId'],'period')));
    default:return never(i);
   }
  case 'dependency':{
   const t=record(i.target,'dependency target');
   switch(i.command){
    case 'graph.layout.set':return none;
    case 'dependency.policy.update':return projects(text(t['projectId'],'project'));
    case 'dependency.create':return projects(await taskProject(text(t['predecessorTaskId'],'predecessor')),await taskProject(text(t['successorTaskId'],'successor')));
    case 'dependency.update':return projects(await taskProject(text(t['predecessorTaskId'],'predecessor')),await taskProject(text(t['successorTaskId'],'successor')));
    default:return never(i);
   }
  }
  case 'recurrence':
   switch(i.command){
    case 'recurrence.series.create':return projects((await repo.tasks.findProject(ws,text(record(i.target,'series target')['projectId'],'project')))?.id);
    case 'recurrence.series.edit':case 'recurrence.series.state':case 'recurrence.periods.add':case 'recurrence.generation.authorize':case 'recurrence.exception.set':
     return projects(await seriesProject(text(record(i.target,'series target')['seriesId'],'series')));
    case 'recurrence.period.materialize':return projects(await periodProject(text(record(i.target,'period target')['periodId'],'period')));
    default:return never(i);
   }
  default:return never(i);
 }
}
