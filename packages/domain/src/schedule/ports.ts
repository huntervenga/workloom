import type {DependencyRepository} from '../dependencies/ports.js';
import type {PlanningWriteScope,PlanningRepository,PlanningTools} from '../planning/ports.js';
import type {RecurrenceScopedMaterializer} from '../recurrence/ports.js';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {WorkspaceAccessRecord} from '../access/ports.js';
export interface TaskScheduleReadScope {
 readonly context:CommandContext;readonly access:WorkspaceAccessRecord;readonly barrierAt:Date;
 readonly repository:PlanningRepository;readonly dependencies:DependencyRepository;
 readonly recurrenceCensus:Pick<RecurrenceScopedMaterializer,'assessPeriod'>;
}
export interface TaskScheduleWriteScope extends PlanningWriteScope {readonly dependencies:DependencyRepository}
export interface TaskScheduleUnitOfWork {
 read<T>(ctx:CommandContext,cap:Capability,work:(scope:TaskScheduleReadScope)=>Promise<T>):Promise<T>;
 run<T>(ctx:CommandContext,cap:Capability,work:(scope:TaskScheduleWriteScope)=>Promise<T>):Promise<T>;
}
export interface TaskScheduleApplicationDependencies {readonly writer:TaskScheduleUnitOfWork;readonly tools:Pick<PlanningTools,'digest'|'newId'>}
