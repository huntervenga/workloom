import type {CreateTaskDependencyInput,UpdateTaskDependencyInput,UpdateDependencyPolicyInput,SetGraphLayoutInput,TaskDependencyListQuery,TaskBlockingQuery,DependencyGraphQuery,DependencyCountsQuery,TaskDependencyCountsDto,TaskDependencyDto,TaskBlockingDto,ProjectDependencyPolicyDto,DependencyGraphDto,GraphLayoutDto} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {PlanningPage} from '../planning/application.js';
/** The nine P4a use cases plus list dependency counts; trusted ctx first, keyed writes. No old task input/hash changes. */
export interface DependencyApplication {
 listDependencies(ctx:CommandContext,query:TaskDependencyListQuery):Promise<PlanningPage<TaskDependencyDto>>;
 createDependency(ctx:CommandContext,input:CreateTaskDependencyInput):Promise<TaskDependencyDto>;
 updateDependency(ctx:CommandContext,dependencyId:string,input:UpdateTaskDependencyInput):Promise<TaskDependencyDto>;
 getTaskBlocking(ctx:CommandContext,taskId:string,query:TaskBlockingQuery):Promise<{data:TaskBlockingDto;nextCursor:string|null}>;
 getProjectPolicy(ctx:CommandContext,projectId:string):Promise<ProjectDependencyPolicyDto>;
 updateProjectPolicy(ctx:CommandContext,projectId:string,input:UpdateDependencyPolicyInput):Promise<ProjectDependencyPolicyDto>;
 getGraph(ctx:CommandContext,projectId:string,query:DependencyGraphQuery):Promise<DependencyGraphDto>;
 getGraphLayout(ctx:CommandContext,projectId:string):Promise<GraphLayoutDto>;
 setGraphLayout(ctx:CommandContext,projectId:string,input:SetGraphLayoutInput):Promise<GraphLayoutDto>;
 /** Read-only: unfinished predecessors and successors per task (up to 100), for list badges. */
 countDependencies(ctx:CommandContext,query:DependencyCountsQuery):Promise<TaskDependencyCountsDto[]>;
}
