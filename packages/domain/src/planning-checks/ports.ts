import type * as C from '@workloom/contracts';
import type {Capability} from '../access/capabilities.js';
import type {CommandContext} from '../access/context.js';
import type {GenericReportScope,GenericSourceTask} from '../generic-reports/ports.js';
export interface PlanningCheckValue {taskId:string;fieldId:string;revision:number;definitionVersionId:string;present:boolean;numberValue:number|null;dateValue:string|null}
/** Deliberately excludes raw custom text/arrays, descriptions and private leave data. */
export interface PlanningCheckSource {durationValues?:C.TaskFieldValueDto[];sharedActivities?:Pick<C.SharedActivityRecordDto,'activity'|'contributions'>[];head:string;fields:C.TaskFieldDefinitionDto[];tasks:GenericSourceTask[];values:PlanningCheckValue[];memberLabels:Record<string,string>;sectionLabels:Record<string,string>;activeSectionIds:string[];excludedLinkedTasks:number}
export interface PlanningCheckCapacity {ruleId:string;membershipId:string;range:{from:string;to:string}|null;availableMinutes:number|null;reason:'member_unavailable'|'schedule_unknown'|'project_dates_missing'|'project_dates_too_long'|null}
export interface PlanningCheckEvaluationInput {source:PlanningCheckSource;settings:C.PlanningCheckSettingsDto;project:C.ProjectDto;asOf:string;timezone:string;weekStart:number;capacities:PlanningCheckCapacity[]}
export interface PlanningCheckEvaluation {assessment:Omit<C.PlanningCheckAssessmentDto,'sourceVersion'>;issues:Map<string,string[]>}
export interface PlanningCheckRepository {
 settings(projectId:string):Promise<C.PlanningCheckSettingsDto>;
 saveSettings(settings:C.PlanningCheckSettingsDto,actorUserId:string,at:string):Promise<void>;
 source(projectId:string,fieldIds:readonly string[],includeSharedActivities?:boolean):Promise<PlanningCheckSource>;
 checkpointCount(projectId:string):Promise<number>;
 insertCheckpoint(value:C.PlanningCheckCheckpointDto):Promise<void>;
 checkpoints(projectId:string,offset:number,limit:number):Promise<{total:number;rows:C.PlanningCheckCheckpointDto[]}>;
 checkpoint(projectId:string,id:string):Promise<C.PlanningCheckCheckpointDto|null>;
}
export interface PlanningCheckScope extends GenericReportScope {checks:PlanningCheckRepository}
export interface PlanningCheckDependencies {read<T>(context:CommandContext,capability:Capability,work:(scope:PlanningCheckScope)=>Promise<T>):Promise<T>;write<T>(context:CommandContext,capability:Capability,work:(scope:PlanningCheckScope)=>Promise<T>):Promise<T>;newId():string;digest(value:string):string}
export interface PlanningCheckApplication {
 getSettings(context:CommandContext,projectId:string):Promise<C.PlanningCheckSettingsDto>;
 setSettings(context:CommandContext,projectId:string,input:C.SetPlanningCheckSettingsInput):Promise<C.PlanningCheckSettingsDto>;
 query(context:CommandContext,projectId:string,input:C.QueryPlanningChecksInput):Promise<C.PlanningCheckAssessmentDto>;
 issues(context:CommandContext,projectId:string,input:C.PlanningCheckIssueQueryInput):Promise<C.PlanningCheckIssuePageDto>;
 capture(context:CommandContext,projectId:string,input:C.CapturePlanningCheckInput):Promise<C.PlanningCheckCheckpointDto>;
 checkpoints(context:CommandContext,projectId:string,input:C.PlanningCheckCheckpointListQueryInput):Promise<C.PlanningCheckCheckpointPageDto>;
 checkpoint(context:CommandContext,projectId:string,id:string):Promise<C.PlanningCheckCheckpointDto>;
}
