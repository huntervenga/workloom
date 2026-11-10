import type {AttachTaskProjectInput,ChangeTaskProjectPlacementStateInput,ProjectRowDto,ProjectRowsQuery,TaskProjectPlacementDto,TransferTaskProjectInput,TransferTaskProjectResult,UpdateTaskProjectPlacementInput} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {TaskCursorAnchor,TaskRepository,TaskTools,TaskWriteScope} from './ports.js';
/** One task and all its subtasks moving to another project. `sectionId` undefined maps the section by name. */
export interface TaskTransferPlan {readonly workspaceId:string;readonly taskId:string;readonly targetProjectId:string;readonly sectionId:string|null|undefined;readonly now:string;/** Keep the former home placements active instead of detaching them. */readonly keepFormerHome?:boolean}
/** A value of the old project that has a matching field in the target; the command writes it through the shared field primitive.
 * `sourceFieldId` is the old project's field that holds it, cleared when the former home stays among the task's projects. */
export interface TaskTransferValue {readonly taskId:string;readonly fieldId:string;readonly sourceFieldId:string;readonly fieldName:string;readonly value:{readonly type:string;readonly value:unknown}}
export interface TaskTransferOutcome {readonly movedTaskIds:string[];readonly values:TaskTransferValue[];/** Values with no matching field or option in the target. */readonly notCarried:{fieldName:string;count:number}[]}
export interface TaskProjectPlacementRepository {
 /** Inside the write transaction only: re-homes the whole subtree atomically, or throws a DomainError naming what blocks it. */
 transferTree(plan:TaskTransferPlan):Promise<TaskTransferOutcome>;
 find(workspaceId:string,placementId:string):Promise<TaskProjectPlacementDto|null>;
 findForTaskProject(workspaceId:string,taskId:string,projectId:string):Promise<TaskProjectPlacementDto|null>;
 listForTask(workspaceId:string,taskId:string,take:number):Promise<TaskProjectPlacementDto[]>;
 listProject(workspaceId:string,projectId:string,includeArchived:boolean,after:TaskCursorAnchor|null,take:number):Promise<TaskProjectPlacementDto[]>;
 maxPosition(workspaceId:string,projectId:string):Promise<number>;
 insert(row:TaskProjectPlacementDto):Promise<void>;
 save(row:TaskProjectPlacementDto):Promise<void>;
}
export interface TaskProjectPlacementWriteScope extends TaskWriteScope {readonly placements:TaskProjectPlacementRepository}
export interface TaskProjectPlacementUnitOfWork {run<T>(context:CommandContext,capability:Capability,work:(scope:TaskProjectPlacementWriteScope)=>Promise<T>):Promise<T>}
export interface TaskProjectPlacementDependencies {readonly reader:TaskProjectPlacementRepository;readonly tasks:TaskRepository;readonly writer:TaskProjectPlacementUnitOfWork;readonly tools:TaskTools}
export type TaskProjectPlacementCommand='task.project.attach'|'task.project.update'|'task.project.detach'|'task.project.restore'|'task.project.transfer';
export interface TaskProjectPlacementApplication {
 listProjectRows(context:CommandContext,projectId:string,input:ProjectRowsQuery):Promise<{items:ProjectRowDto[];nextCursor:string|null}>;
 listTaskPlacements(context:CommandContext,taskId:string):Promise<TaskProjectPlacementDto[]>;
 attachTaskProject(context:CommandContext,taskId:string,input:AttachTaskProjectInput):Promise<TaskProjectPlacementDto>;
 transferTaskProject(context:CommandContext,taskId:string,input:TransferTaskProjectInput):Promise<TransferTaskProjectResult>;
 updateTaskProjectPlacement(context:CommandContext,placementId:string,input:UpdateTaskProjectPlacementInput):Promise<TaskProjectPlacementDto>;
 detachTaskProjectPlacement(context:CommandContext,placementId:string,input:ChangeTaskProjectPlacementStateInput):Promise<TaskProjectPlacementDto>;
 restoreTaskProjectPlacement(context:CommandContext,placementId:string,input:ChangeTaskProjectPlacementStateInput):Promise<TaskProjectPlacementDto>;
}
