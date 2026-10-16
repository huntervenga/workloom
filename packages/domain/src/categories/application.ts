import type {CategorizedWorkLogDto,CreateWorkTypeReportRunInput,PlanningPageQuery,ProjectWorkCategoryBindingDto,RecategorizeWorkLogInput,TaskTimeSummaryDto,TaskTimeSummaryQuery,UpdateProjectWorkCategoryBindingInput,WorkTypeReportRowDto,WorkTypeReportRunDto,WorkTypeReportRunListQuery} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {PlanningPage} from '../planning/application.js';
/** Trusted ctx first. Every mutation requires a key; current ACL before replay. */
export interface WorkCategoryApplication {
 getBinding(ctx:CommandContext,projectId:string):Promise<ProjectWorkCategoryBindingDto>;
 updateBinding(ctx:CommandContext,projectId:string,input:UpdateProjectWorkCategoryBindingInput):Promise<ProjectWorkCategoryBindingDto>;
 recategorizeWorkLog(ctx:CommandContext,workLogId:string,input:RecategorizeWorkLogInput):Promise<CategorizedWorkLogDto>;
 listReportRuns(ctx:CommandContext,query:WorkTypeReportRunListQuery):Promise<PlanningPage<WorkTypeReportRunDto>>;
 createReportRun(ctx:CommandContext,input:CreateWorkTypeReportRunInput):Promise<WorkTypeReportRunDto>;
 getReportRun(ctx:CommandContext,runId:string):Promise<WorkTypeReportRunDto>;
 listReportRows(ctx:CommandContext,runId:string,query:PlanningPageQuery):Promise<PlanningPage<WorkTypeReportRowDto>>;
 getTaskTimeSummary(ctx:CommandContext,projectId:string,periodId:string,query:TaskTimeSummaryQuery):Promise<TaskTimeSummaryDto>;
}
