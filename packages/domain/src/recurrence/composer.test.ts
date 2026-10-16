import {describe,expect,it} from 'vitest';
import type {MeetingDto,RecurrenceResolutionDto,TaskDto} from '@workloom/contracts';
import {reviseOccurrenceMeetingInScope} from './composer.js';
import {recurrenceProtectedReasons} from './service.js';
import type {RecurrenceInstanceHeader,RecurrenceRepository,RecurrenceWriteScope} from './ports.js';
import type {ChangeEventInput} from '../transactions/ports.js';

const id=(n:number)=>`abcdef00-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now='2026-11-02T10:00:00.000Z';
const task:TaskDto={id:id(1),meetingId:id(2),workspaceId:id(3),projectId:id(4),sectionId:null,parentTaskId:null,workPackageId:id(5),workPackageRevision:1,title:'Same title',description:'',statusId:id(6),responsibleMembershipId:id(7),participants:[],participantsRevision:1,dueDate:'2026-11-03',priority:'none',tags:[],estimateMinutes:30,revision:1,position:0,visibility:'workspace',archivedAt:null,createdAt:now,updatedAt:now};
const meeting:MeetingDto={id:id(2),workspaceId:id(3),projectId:id(4),taskId:id(1),workPackageId:id(5),revision:1,participantsRevision:1,plannedPeriodId:id(8),plannedStartAt:'2026-11-03T09:00:00.000Z',timezone:'UTC',plannedDurationMinutes:30,organizerMembershipId:id(7),state:'scheduled',actualStartAt:null,actualDurationMinutes:null,joinUrl:null,recordingUrl:null,summaryUrl:null,summaryText:null,scheduleFrozen:false,hasPostedAttendance:false,createdAt:now,updatedAt:now};
const resolution:RecurrenceResolutionDto={policyVersion:'first_valid_gap_earlier_overlap_v1',intendedLocalDate:'2026-11-03',intendedLocalTime:'09:00',resolvedStartAt:meeting.plannedStartAt,resolvedEndAt:'2026-11-03T09:30:00.000Z',resolvedLocalDate:'2026-11-03',resolvedLocalTime:'09:00',resolvedOffset:'+00:00',plannedDurationMinutes:30,warning:null,provenance:{timezone:'UTC',implementation:'test',tzdataVersion:null,icuVersion:null}};
const header:RecurrenceInstanceHeader={id:id(9),workspaceId:id(3),projectId:id(4),seriesId:id(10),bindingId:id(11),periodId:id(8),occurrenceKey:'2026-11-03',nominalSequence:null,sourceVersionId:id(12),revision:2,calendarState:'scheduled',resolution,exceptionVersionId:null,locator:{meetingId:id(2),taskId:id(1),workPackageId:id(5)},createdAt:now,updatedAt:now};

describe('recurrence template task projection',()=>{
 it.each([{patch:{statusId:id(13)},field:'statusId'},{patch:{sectionId:id(14)},field:'sectionId'}])('applies a $field-only template change without requiring a changed title',async({patch,field})=>{
  const saved:TaskDto[]=[],changes:ChangeEventInput[]=[];
  const scope={context:{workspaceId:id(3)},barrierAt:new Date(now),repository:{findMeetingByTask:async()=>meeting,listAttendance:async()=>[{membershipId:id(7),rosterActive:true}],tasks:{findTask:async()=>task,saveTaskCore:async(row:TaskDto)=>{saved.push(row);}}},recordChange:async(change:ChangeEventInput)=>{changes.push(change);return {changeSeq:1n,eventOrdinal:1};}} as unknown as RecurrenceWriteScope;
  const target={calendarState:'scheduled' as const,resolution,version:{schedule:{startDate:'2026-11-03',localTime:'09:00',timezone:'UTC',frequency:'daily' as const,plannedDurationMinutes:30,end:{kind:'on_date' as const,endDate:'2026-11-03'}},template:{title:task.title,statusId:task.statusId,sectionId:task.sectionId,organizerMembershipId:id(7),attendeeMembershipIds:[id(7)],...patch}}};
  expect(await reviseOccurrenceMeetingInScope(scope,header,target,{newId:()=>id(20)})).toEqual(meeting);
  expect(saved).toEqual([{...task,...patch,revision:2,updatedAt:now}]);
  expect(changes).toHaveLength(1);expect(changes[0]?.diff).toMatchObject({fields:[field]});
  saved.length=0;changes.length=0;
  await reviseOccurrenceMeetingInScope(scope,header,target,{newId:()=>id(20)},'schedule');
  expect(saved).toEqual([]);expect(changes).toEqual([]);
 });
});


it('does not backdate an existing future occurrence when a series edit moves its clock earlier today',async()=>{
 const repo={listCalendarLocks:async()=>[]} as unknown as RecurrenceRepository;
 const future={...header,locator:null,resolution:{...resolution,resolvedStartAt:'2026-11-03T16:00:00.000Z'}};
 const at=new Date('2026-11-03T12:00:00.000Z');
 expect(await recurrenceProtectedReasons(repo,future,at)).toEqual([]);
 expect(await recurrenceProtectedReasons(repo,future,at,'2026-11-03T09:00:00.000Z')).toEqual(['past']);
 expect(await recurrenceProtectedReasons(repo,future,at,'2026-11-03T13:00:00.000Z')).toEqual([]);
});
