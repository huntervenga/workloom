import {
  meetingListResponseSchema, meetingResponseSchema, meetingCreationResponseSchema,
  meetingAttendanceListResponseSchema, attendancePostingResponseSchema, attendanceHistoryListResponseSchema,
  meetingPlanPreviewResponseSchema, meetingPlanResultResponseSchema, recordedWorkListResponseSchema,
  createMeetingInputSchema, updateMeetingInputSchema, confirmAttendanceInputSchema,
  meetingPlanPreviewInputSchema, applyMeetingPlanInputSchema,
  type CreateMeetingInput, type UpdateMeetingInput, type ConfirmAttendanceInput, type MeetingPlanPreviewInput,
  type ApplyMeetingPlanInput, type MeetingListItemDto, type AttendanceDto, type AttendanceHistoryDto, type RecordedWorkLogDto,
} from '@workloom/contracts';
import { apiGet, apiRequest, ApiError, prepareMutation, type ResponseParser } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
const p = encodeURIComponent;
const taskPath = (w: string, t: string) => `${workspacePath(w)}/tasks/${p(t)}`;
async function all<T>(url: string, parser: ResponseParser<{data: T[];meta:{nextCursor?:string|null}}>, query: Record<string,string>, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = []; const seen = new Set<string>(); let cursor: string | null = null;
  do {
    const search: URLSearchParams = new URLSearchParams({ ...query, limit: '100', ...(cursor ? { cursor } : {}) });
    const page: {data:T[];meta:{nextCursor?:string|null}} = await apiGet(`${url}?${search}`, parser, signal); result.push(...page.data); cursor = page.meta.nextCursor ?? null;
    if (cursor) { if (seen.has(cursor)) throw new ApiError({kind:'invalid_response',status:200}); seen.add(cursor); }
  } while(cursor); return result;
}
export const fetchMeetings = (w: string, project: string, period: string, signal?: AbortSignal): Promise<MeetingListItemDto[]> => all(`${workspacePath(w)}/projects/${p(project)}/meetings`,meetingListResponseSchema,{plannedPeriodId:period,state:'all'},signal);
export const fetchMeeting = async (w: string,t: string,signal?:AbortSignal) => (await apiGet(`${taskPath(w,t)}/meeting`,meetingResponseSchema,signal)).data;
export const fetchAttendance = (w:string,t:string,signal?:AbortSignal):Promise<AttendanceDto[]> => all(`${taskPath(w,t)}/attendance`,meetingAttendanceListResponseSchema,{},signal);
export const fetchAttendanceHistory = (w:string,t:string,id:string,signal?:AbortSignal):Promise<AttendanceHistoryDto[]> => all(`${taskPath(w,t)}/attendance/${p(id)}/history`,attendanceHistoryListResponseSchema,{},signal);
export const fetchRecordedWork = (w:string,period:string,signal?:AbortSignal):Promise<RecordedWorkLogDto[]> => all(`${workspacePath(w)}/recorded-work`,recordedWorkListResponseSchema,{periodId:period},signal);
export const createMeetingRequest = (w:string,project:string,input:CreateMeetingInput) => prepareMutation({method:'POST',path:`${workspacePath(w)}/projects/${p(project)}/meetings`,input,inputSchema:createMeetingInputSchema,responseSchema:meetingCreationResponseSchema});
export const updateMeetingRequest = (w:string,t:string,input:UpdateMeetingInput) => prepareMutation({method:'PATCH',path:`${taskPath(w,t)}/meeting`,input,inputSchema:updateMeetingInputSchema,responseSchema:meetingResponseSchema});
export const confirmAttendanceRequest = (w:string,t:string,input:ConfirmAttendanceInput) => prepareMutation({method:'POST',path:`${taskPath(w,t)}/attendance/confirm`,input,inputSchema:confirmAttendanceInputSchema,responseSchema:attendancePostingResponseSchema});
export const applyMeetingPlanRequest = (w:string,t:string,input:ApplyMeetingPlanInput) => prepareMutation({method:'POST',path:`${taskPath(w,t)}/meeting-plan`,input,inputSchema:applyMeetingPlanInputSchema,responseSchema:meetingPlanResultResponseSchema});
export async function fetchMeetingPlanPreview(w:string,t:string,input:MeetingPlanPreviewInput,signal?:AbortSignal) {
  const value = meetingPlanPreviewInputSchema.safeParse(input); if(!value.success) throw new ApiError({kind:'invalid_input',status:null});
  const response = await apiRequest(`${taskPath(w,t)}/meeting-plan-preview`,{method:'POST',body:value.data,signal});
  const parsed = meetingPlanPreviewResponseSchema.safeParse(response.payload); if(!parsed.success) throw new ApiError({kind:'invalid_response',status:response.status}); return parsed.data.data;
}
