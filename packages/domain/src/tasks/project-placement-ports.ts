import type {AttachTaskProjectInput,ChangeTaskProjectPlacementStateInput,ProjectRowDto,ProjectRowsQuery,TaskProjectPlacementDto,UpdateTaskProjectPlacementInput} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {TaskCursorAnchor,TaskRepository,TaskTools,TaskWriteScope} from './ports.js';
export interface TaskProjectPlacementRepository {
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
export type TaskProjectPlacementCommand='task.project.attach'|'task.project.update'|'task.project.detach'|'task.project.restore';
export interface TaskProjectPlacementApplication {
 listProjectRows(context:CommandContext,projectId:string,input:ProjectRowsQuery):Promise<{items:ProjectRowDto[];nextCursor:string|null}>;
 listTaskPlacements(context:CommandContext,taskId:string):Promise<TaskProjectPlacementDto[]>;
 attachTaskProject(context:CommandContext,taskId:string,input:AttachTaskProjectInput):Promise<TaskProjectPlacementDto>;
 updateTaskProjectPlacement(context:CommandContext,placementId:string,input:UpdateTaskProjectPlacementInput):Promise<TaskProjectPlacementDto>;
 detachTaskProjectPlacement(context:CommandContext,placementId:string,input:ChangeTaskProjectPlacementStateInput):Promise<TaskProjectPlacementDto>;
 restoreTaskProjectPlacement(context:CommandContext,placementId:string,input:ChangeTaskProjectPlacementStateInput):Promise<TaskProjectPlacementDto>;
}
