import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMeetingInput, UpdateMeetingInput, ConfirmAttendanceInput, ApplyMeetingPlanInput, AttendancePostingDto, MeetingPlanResultDto } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { isUuid } from '../../lib/format';
import { planningKeys } from '../planning/queries';
import { fetchMeeting, fetchMeetings, fetchAttendance, fetchAttendanceHistory, fetchRecordedWork, createMeetingRequest, updateMeetingRequest, confirmAttendanceRequest, applyMeetingPlanRequest } from './api';
export const meetingKeys = {
 root:(a:string,w:string)=>[...queryKeys.workspace(a,w),'meetings'] as const,
 detail:(a:string,w:string,t:string)=>[...meetingKeys.root(a,w),t.toLowerCase()] as const,
 list:(a:string,w:string,p:string,week:string)=>[...meetingKeys.root(a,w),'list',p,week] as const,
 attendance:(a:string,w:string,t:string)=>[...meetingKeys.detail(a,w,t),'attendance'] as const,
 history:(a:string,w:string,t:string,id:string)=>[...meetingKeys.attendance(a,w,t),'history',id] as const,
 recorded:(a:string,w:string,period:string)=>[...planningKeys.period(a,w,period),'recorded-work'] as const,
};
export const useMeetingQuery=(a:string,w:string,t:string)=>useQuery({queryKey:meetingKeys.detail(a,w,t),queryFn:({signal})=>fetchMeeting(w,t,signal),enabled:isUuid(t)});
export const useMeetingsQuery=(a:string,w:string,p:string,week:string)=>useQuery({queryKey:meetingKeys.list(a,w,p,week),queryFn:({signal})=>fetchMeetings(w,p,week,signal),enabled:isUuid(week)});
export const useAttendanceQuery=(a:string,w:string,t:string)=>useQuery({queryKey:meetingKeys.attendance(a,w,t),queryFn:({signal})=>fetchAttendance(w,t,signal),enabled:isUuid(t)});
export const useAttendanceHistoryQuery=(a:string,w:string,t:string,id:string)=>useQuery({queryKey:meetingKeys.history(a,w,t,id),queryFn:({signal})=>fetchAttendanceHistory(w,t,id,signal),enabled:isUuid(id)});
export const useRecordedWorkQuery=(a:string,w:string,period:string)=>useQuery({queryKey:meetingKeys.recorded(a,w,period),queryFn:({signal})=>fetchRecordedWork(w,period,signal),enabled:isUuid(period)});
export interface AttendanceVariables extends IdempotentVariables {taskId:string;input:ConfirmAttendanceInput;attendanceMode?:'team'}
export interface MeetingPlanVariables extends IdempotentVariables {taskId:string;input:ApplyMeetingPlanInput}
export function useMeetingCommands(a:string,w:string,p:string,onAttendanceConfirmed?:((data:AttendancePostingDto,variables:AttendanceVariables)=>void),onPlanConfirmed?:((data:MeetingPlanResultDto,variables:MeetingPlanVariables)=>void)) {
 const client=useQueryClient();
 const refresh=()=>{
  void client.invalidateQueries({queryKey:meetingKeys.root(a,w)});
  void client.invalidateQueries({queryKey:planningKeys.root(a,w)});
  void client.invalidateQueries({queryKey:queryKeys.tasks(a,w)});
  void client.invalidateQueries({queryKey:queryKeys.timeSummaries(a,w)});
 };
 const create=useIdempotentMutation({prepare:({input}:IdempotentVariables & {input:CreateMeetingInput})=>createMeetingRequest(w,p,input),onSuccess:refresh});
 const update=useIdempotentMutation({prepare:({taskId,input}:IdempotentVariables & {taskId:string;input:UpdateMeetingInput})=>updateMeetingRequest(w,taskId,input),onSuccess:refresh});
 const attendance=useIdempotentMutation({prepare:({taskId,input}:AttendanceVariables)=>confirmAttendanceRequest(w,taskId,input),onSuccess:(data,variables)=>{onAttendanceConfirmed?.(data,variables);refresh();}});
 const plan=useIdempotentMutation({prepare:({taskId,input}:MeetingPlanVariables)=>applyMeetingPlanRequest(w,taskId,input),onSuccess:(data,variables)=>{onPlanConfirmed?.(data,variables);refresh();}});
 return {create,update,attendance,plan};
}
export type MeetingCommands=ReturnType<typeof useMeetingCommands>;
