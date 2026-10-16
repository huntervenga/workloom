import type {TaskScheduleContextQuery,TaskScheduleBatchInput,TaskScheduleApplyInput,TaskScheduleContextDto,TaskSchedulePreviewDto,TaskScheduleApplyDto} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
export interface TaskScheduleApplication {
 getScheduleContext(ctx:CommandContext,projectId:string,query:TaskScheduleContextQuery):Promise<TaskScheduleContextDto>;
 previewSchedule(ctx:CommandContext,projectId:string,input:TaskScheduleBatchInput):Promise<TaskSchedulePreviewDto>;
 applySchedule(ctx:CommandContext,projectId:string,input:TaskScheduleApplyInput):Promise<TaskScheduleApplyDto>;
}
