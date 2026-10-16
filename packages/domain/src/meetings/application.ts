import type {MeetingListQuery,MeetingListItemDto,CreateMeetingInput,MeetingCreationDto,MeetingDto,UpdateMeetingInput,PlanningPageQuery,AttendanceDto,ConfirmAttendanceInput,AttendancePostingDto,RecordedWorkListQuery,RecordedWorkLogDto,AttendanceHistoryDto,MeetingPlanPreviewInput,MeetingPlanPreviewDto,ApplyMeetingPlanInput,MeetingPlanResultDto} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {PlanningPage} from '../planning/application.js';
export interface MeetingApplication {
 listMeetings(ctx:CommandContext,projectId:string,query:MeetingListQuery):Promise<PlanningPage<MeetingListItemDto>>;
 createMeeting(ctx:CommandContext,projectId:string,input:CreateMeetingInput):Promise<MeetingCreationDto>;
 getMeeting(ctx:CommandContext,taskId:string):Promise<MeetingDto>;
 updateMeeting(ctx:CommandContext,taskId:string,input:UpdateMeetingInput):Promise<MeetingDto>;
 listAttendance(ctx:CommandContext,taskId:string,query:PlanningPageQuery):Promise<PlanningPage<AttendanceDto>>;
 confirmAttendance(ctx:CommandContext,taskId:string,input:ConfirmAttendanceInput):Promise<AttendancePostingDto>;
 listRecordedWork(ctx:CommandContext,query:RecordedWorkListQuery):Promise<PlanningPage<RecordedWorkLogDto>>;
 listAttendanceHistory(ctx:CommandContext,taskId:string,attendanceId:string,query:PlanningPageQuery):Promise<PlanningPage<AttendanceHistoryDto>>;
 previewMeetingPlan(ctx:CommandContext,taskId:string,input:MeetingPlanPreviewInput):Promise<MeetingPlanPreviewDto>;
 applyMeetingPlan(ctx:CommandContext,taskId:string,input:ApplyMeetingPlanInput):Promise<MeetingPlanResultDto>;
}
