import type {DependencyTaskContextDto,TaskDto,TaskDependencyDto,ProjectDependencyPolicyDto,GraphLayoutDto,TaskDependencyListQuery,TaskFieldData} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {WorkspaceAccessRecord} from '../access/ports.js';
import type {TaskRepository} from '../tasks/ports.js';
import type {PlanningWriteScope,PlanningTools} from '../planning/ports.js';
export type DependencyMutationCommand='dependency.create'|'dependency.update'|'dependency.policy.update'|'graph.layout.set';
export interface DependencyTaskProjection {readonly task:TaskDto;readonly context:DependencyTaskContextDto}
export interface DependencyRepository {
 readonly tasks:TaskRepository;
 currentChangeSeq(ws:string):Promise<string>;
 findNaturalEdge(ws:string,predecessor:string,successor:string):Promise<TaskDependencyDto|null>;
 listScopedEdges(ws:string,query:TaskDependencyListQuery,after:string|null,take:number):Promise<TaskDependencyDto[]>;
 incidentEdges(ws:string,taskIds:readonly string[],take:number):Promise<TaskDependencyDto[]>;
 inducedEdges(ws:string,taskIds:readonly string[],take:number):Promise<TaskDependencyDto[]>;
 outsideDependencies(ws:string,taskIds:readonly string[]):Promise<Set<string>>;
 findEdge(ws:string,id:string):Promise<TaskDependencyDto|null>;
 saveEdge(row:TaskDependencyDto,exists:boolean):Promise<void>;
 wouldCreateCycle(ws:string,predecessor:string,successor:string):Promise<boolean>;
 taskContexts(ws:string,ids:readonly string[]):Promise<DependencyTaskProjection[]>;
 unresolvedIncoming(ws:string,taskId:string,after:string|null,take:number):Promise<TaskDependencyDto[]>;
 unresolvedCounts(ws:string,taskIds:readonly string[]):Promise<Map<string,number>>;
 getPolicy(ws:string,projectId:string):Promise<ProjectDependencyPolicyDto>;
 getPolicies(ws:string,projectIds:readonly string[]):Promise<Map<string,ProjectDependencyPolicyDto>>;
 savePolicy(ws:string,row:ProjectDependencyPolicyDto):Promise<void>;
 getLayout(ws:string,projectId:string,membershipId:string):Promise<GraphLayoutDto>;
 saveLayout(row:GraphLayoutDto,newId:string):Promise<void>;
}
/** Mandatory domain policy shared by ordinary task updates and internal recurrence task writes. */
export interface TaskStatusTransitionOptions {
 /** Internal creation only; candidate values are validated and saved by the same atomic command. */
 readonly creating?:true;
 readonly fieldValues?:readonly {readonly fieldId:string;readonly value:TaskFieldData}[];
 /** Values this atomic command will write, used to evaluate the prospective rule scope. */
 readonly prospective?:Partial<Pick<TaskDto,'parentTaskId'|'responsibleMembershipId'|'dueDate'>> & {readonly tagIds?:readonly string[]};
}
export interface TaskStatusTransitionPolicy {assertTransition(task:TaskDto,nextStatusId:string,options?:TaskStatusTransitionOptions):Promise<void>}
export interface DependencyWriteScope extends PlanningWriteScope {readonly dependencies:DependencyRepository}
export interface DependencyUnitOfWork {
 run<T>(ctx:CommandContext,cap:Capability,work:(scope:DependencyWriteScope)=>Promise<T>):Promise<T>;
 read<T>(ctx:CommandContext,cap:Capability,work:(repo:DependencyRepository,access:WorkspaceAccessRecord)=>Promise<T>):Promise<T>;
}
export interface DependencyApplicationDependencies {readonly writer:DependencyUnitOfWork;readonly tools:PlanningTools}
