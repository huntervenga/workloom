import type { AttendanceDto, MeetingDto, MeetingPlanPreviewDto, TaskDto } from '@workloom/contracts';
import { useRef, useState } from 'react';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { useWorkCategoryCommands } from '../work-categories/queries';
import type { RecategorizeSession } from '../work-categories/RecategorizeDialog';
import { useSetTaskFieldValueMutation, type FieldValueDraftStore } from '../fields';
import { taskWouldRegress, tagsWouldRegress, useUpdateTaskMutation } from '../tasks/queries';
import { useMeetingCommands } from './queries';
import { formatEstimateInput } from '../task-table';
import { clockChoice, meetingLocal } from './time';
export type MeetingTab='meeting'|'plan'|'attendance';
export interface MeetingSelection {membershipId?:string;attendanceId?:string;requestedPeriodId?:string}
export interface AttendanceDraft {status:'unknown'|'present'|'partial'|'absent'|'void';minutes:string;basis:'actual_meeting'|'planned_absence';reason:string;base:AttendanceDto}
export interface MeetingTaskDraft {title:string;description:string;statusId:string;priority:TaskDto['priority'];tagIds:string[]}
export interface MeetingDraft {
 basics:MeetingTaskDraft;planInitializedFor:string[];batchSelectedIds:string[];
 base:MeetingDto;task:TaskDto;local:string;zone:string;choice:string;duration:string;organizer:string;attendees:string[];
 actualLocal:string;actualChoice:string;actualDuration:string;joinUrl:string;recordingUrl:string;summaryUrl:string;summaryText:string;
 plan:Record<string,string>;preview:MeetingPlanPreviewDto|null;attendance:Record<string,AttendanceDraft>;
}
export function draftForMeeting(meeting:MeetingDto,task:TaskDto):MeetingDraft {
 return {basics:{title:task.title,description:task.description,statusId:task.statusId,priority:task.priority,tagIds:task.tags.map(tag=>tag.id)},planInitializedFor:[],batchSelectedIds:[],base:meeting,task,local:meetingLocal(meeting.plannedStartAt,meeting.timezone),zone:meeting.timezone,choice:clockChoice(meeting.plannedStartAt,meeting.timezone),duration:String(meeting.plannedDurationMinutes),organizer:meeting.organizerMembershipId,attendees:task.participants.filter(p=>p.active).map(p=>p.membershipId),actualLocal:meeting.actualStartAt?meetingLocal(meeting.actualStartAt,meeting.timezone):'',actualChoice:meeting.actualStartAt?clockChoice(meeting.actualStartAt,meeting.timezone):'',actualDuration:meeting.actualDurationMinutes===null?'':String(meeting.actualDurationMinutes),joinUrl:meeting.joinUrl??'',recordingUrl:meeting.recordingUrl??'',summaryUrl:meeting.summaryUrl??'',summaryText:meeting.summaryText??'',plan:{},preview:null,attendance:{}};
}
export function useMeetingWorkspace(actorId:string,workspaceId:string,projectId:string) {
 const [drafts,setDrafts]=useState<Record<string,MeetingDraft>>({});
 // The response is a full roster. Only the immutable command owns the rows it submitted.
 // This page-level callback also runs for a retry from a closed drawer's notice.
 const commands=useMeetingCommands(actorId,workspaceId,projectId,(result,variables)=>{
  const submittedIds=new Set(variables.input.rows.map(row=>row.attendanceId));
  setDrafts(before=>{const current=before[variables.taskId];if(!current)return before;return {...before,[variables.taskId]:{...current,base:result.meeting.revision>=current.base.revision?result.meeting:current.base,attendance:Object.fromEntries(Object.entries(current.attendance).filter(([id])=>!submittedIds.has(id))),batchSelectedIds:current.batchSelectedIds.filter(id=>!submittedIds.has(id))}};});
 },(_result,variables)=>{
  const submittedMemberships=new Set(variables.input.rows.map(row=>row.membershipId));
  setDrafts(before=>{const current=before[variables.taskId];if(!current)return before;return {...before,[variables.taskId]:{...current,preview:null,plan:Object.fromEntries(Object.entries(current.plan).filter(([id])=>!submittedMemberships.has(id)))}};});
 });
 const taskUpdate=useUpdateTaskMutation(actorId,workspaceId);
 const fieldValueMutation=useSetTaskFieldValueMutation(actorId,workspaceId);
 const fieldValueDrafts=useRef<FieldValueDraftStore>(new Map());
 const categoryCommands=useWorkCategoryCommands(actorId,workspaceId,projectId);
 const [categoryDrafts,setCategoryDrafts]=useState<Record<string,RecategorizeSession>>({});
 const [categoryKey,setCategoryKey]=useState<string|null>(null);
 const [categoryOpen,setCategoryOpen]=useState(false);

 const [target,setTarget]=useState<({taskId:string;tab:MeetingTab}&MeetingSelection)|null>(null);
 const [createOpen,setCreateOpen]=useState(false);
 const [createDraft,setCreateDraft]=useState<CreateMeetingDraft|null>(null);
 const dirty=Object.values(drafts).some(meetingDraftDirty)||createDraft!==null||Object.keys(categoryDrafts).length>0;
 useUnsavedChangesWarning(dirty);
 useProtectedDraft(dirty);
 return {commands,fieldValueMutation,fieldValueDrafts,taskUpdate,categoryCommands,categoryDrafts,setCategoryDrafts,categoryKey,setCategoryKey,categoryOpen,setCategoryOpen,drafts,setDrafts,target,setTarget,createOpen,setCreateOpen,createDraft,setCreateDraft};
}
export type MeetingWorkspace=ReturnType<typeof useMeetingWorkspace>;

export interface CreateMeetingDraft {title:string;periodId:string;local:string;zone:string;choice:string;duration:string;organizer:string;attendees:string[];joinUrl:string;statusId:string;sectionId:string}
export function meetingDraftDirty(d:MeetingDraft):boolean {
 const b=d.base;
 return d.basics.title!==d.task.title||d.basics.description!==d.task.description||d.basics.statusId!==d.task.statusId||d.basics.priority!==d.task.priority||JSON.stringify([...d.basics.tagIds].sort())!==JSON.stringify(d.task.tags.map(tag=>tag.id).sort())||d.choice!==clockChoice(b.plannedStartAt,b.timezone)||d.actualChoice!==(b.actualStartAt?clockChoice(b.actualStartAt,b.timezone):'')||d.local!==meetingLocal(b.plannedStartAt,b.timezone)||d.zone!==b.timezone||d.duration!==String(b.plannedDurationMinutes)||d.organizer!==b.organizerMembershipId||JSON.stringify([...d.attendees].sort())!==JSON.stringify(d.task.participants.filter(p=>p.active).map(p=>p.membershipId).sort())||d.actualLocal!==(b.actualStartAt?meetingLocal(b.actualStartAt,b.timezone):'')||d.actualDuration!==(b.actualDurationMinutes===null?'':String(b.actualDurationMinutes))||d.joinUrl!==(b.joinUrl??'')||d.recordingUrl!==(b.recordingUrl??'')||d.summaryUrl!==(b.summaryUrl??'')||d.summaryText!==(b.summaryText??'')||Object.keys(d.plan).length>0||Object.values(d.attendance).some(a=>a.status!==(a.base.postingState==='void'?'void':a.base.status)||a.minutes!==formatEstimateInput(a.base.minutes)||a.reason!==''||a.basis!==(a.base.workLog?.attribution.basis??'planned_absence'));
}
/** Refresh independent guards while retaining input typed after the submitted snapshot. */
export function reconcileMeetingTask(current:MeetingDraft,task:TaskDto,submitted?:MeetingTaskDraft):MeetingDraft {
 if(taskWouldRegress(current.task,task)||tagsWouldRegress(task,current.task.tags))return current;
 const nextBasics:MeetingTaskDraft={title:task.title,description:task.description,statusId:task.statusId,priority:task.priority,tagIds:task.tags.map(tag=>tag.id)};
 const oldBasics:MeetingTaskDraft={title:current.task.title,description:current.task.description,statusId:current.task.statusId,priority:current.task.priority,tagIds:current.task.tags.map(tag=>tag.id)};
 const basics={...current.basics};
 for(const key of ['title','description','statusId','priority','tagIds'] as const){
  const same=JSON.stringify(current.basics[key])===JSON.stringify(oldBasics[key])||(submitted!==undefined&&JSON.stringify(current.basics[key])===JSON.stringify(submitted[key]));
  if(same){if(key==='tagIds')basics.tagIds=nextBasics.tagIds;else if(key==='priority')basics.priority=nextBasics.priority;else basics[key]=nextBasics[key];}
 }
 const oldPeople=current.task.participants.filter(p=>p.active).map(p=>p.membershipId).sort();
 const untouched=JSON.stringify([...current.attendees].sort())===JSON.stringify(oldPeople);
 return {...current,task,basics,attendees:untouched?task.participants.filter(p=>p.active).map(p=>p.membershipId):current.attendees};
}
