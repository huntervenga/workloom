import type {CategorizedWorkLogDto,RecordedWorkLogDto,ProjectWorkCategoryBindingDto,WorkCategorySnapshot,WorkTypeReportRunDto,WorkTypeReportRowDto} from '@workloom/contracts';
import type {Capability} from '../access/capabilities.js';
import type {CommandContext} from '../access/context.js';
import type {PlanningCursor,PlanningRepository,PlanningTools,PlanningWriteScope} from '../planning/ports.js';

export interface WorkCategoryBindingRecord {readonly workspaceId:string;readonly projectId:string;readonly revision:number;readonly versionId:string;readonly fieldId:string|null}
export interface WorkCategoryBindingVersion extends WorkCategoryBindingRecord {readonly actorUserId:string;readonly recordedAt:string;readonly changeSeq:string}
export interface WorkCategoryRepository {
 readonly planning:PlanningRepository;
 findBinding(workspaceId:string,projectId:string):Promise<WorkCategoryBindingRecord|null>;
 saveBinding(row:WorkCategoryBindingRecord,exists:boolean):Promise<void>;
 insertBindingVersion(row:WorkCategoryBindingVersion):Promise<void>;
 findWorkLog(workspaceId:string,id:string):Promise<RecordedWorkLogDto|null>;
 listReportRuns(workspaceId:string,periodId:string):Promise<WorkTypeReportRunDto[]>;
 findReportRun(workspaceId:string,id:string):Promise<{run:WorkTypeReportRunDto;rows:WorkTypeReportRowDto[]}|null>;
 insertReportRun(run:WorkTypeReportRunDto,rows:WorkTypeReportRowDto[]):Promise<void>;
}
export interface WorkCategoryWriteScope extends PlanningWriteScope {readonly categories:WorkCategoryRepository}
export interface WorkCategoryUnitOfWork {
 run<T>(ctx:CommandContext,cap:Capability,work:(scope:WorkCategoryWriteScope)=>Promise<T>):Promise<T>;
 read<T>(ctx:CommandContext,cap:Capability,work:(repo:WorkCategoryRepository)=>Promise<T>):Promise<T>;
}
export interface WorkCategoryApplicationDependencies {readonly writer:WorkCategoryUnitOfWork;readonly tools:PlanningTools}
export interface WorkCategoryResolver {resolve(taskId:string):Promise<WorkCategorySnapshot>}
export type WorkCategoryMutationCommand='category.binding.update'|'work.recategorize'|'work_type_report.create';
export type {PlanningCursor,CategorizedWorkLogDto,ProjectWorkCategoryBindingDto};
