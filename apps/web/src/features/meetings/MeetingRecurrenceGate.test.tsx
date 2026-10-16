import type { AttendanceDto, MeetingDto, TaskDto, UpdateMeetingInput } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, deferred, installFakeApi, ok, renderApp, type RouteTable } from '../../test/fakeApi';
import { MEMBER_ID, PERIOD_A, PERIOD_B, PROJECT_ID, TASK_ID, STAMP, rootPath, task } from '../planning/test/fixtures';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
const MEETING='ab000000-0000-4000-8000-000000000011';
const ATTENDANCE='ac000000-0000-4000-8000-000000000011';
const SERIES_ID='ae000000-0000-4000-8000-000000000001';
const INSTANCE_ID='af000000-0000-4000-8000-000000000001';
const PLANNED_START='2026-10-28T08:00:00.000Z';
/** Synthetic occurrence of a series in its original week B while the table lens stays on week A. */
function recurringMeeting(overrides:Partial<MeetingDto>={}):MeetingDto {return {id:MEETING,workspaceId:alpha.id,projectId:PROJECT_ID,taskId:TASK_ID,workPackageId:task.workPackageId,revision:1,participantsRevision:1,plannedPeriodId:PERIOD_B,plannedStartAt:PLANNED_START,timezone:'Europe/Berlin',plannedDurationMinutes:45,organizerMembershipId:MEMBER_ID,state:'scheduled',actualStartAt:null,actualDurationMinutes:null,joinUrl:null,recordingUrl:null,summaryUrl:null,summaryText:null,scheduleFrozen:false,hasPostedAttendance:false,createdAt:STAMP,updatedAt:STAMP,recurrence:{seriesId:SERIES_ID,instanceId:INSTANCE_ID,occurrenceKey:'2026-10-28',nominalSequence:3},...overrides};}
/** An older stored/replayed P3a outcome: identical fields, no series ref. */
function withoutSeries(meeting:MeetingDto):MeetingDto {const copy={...meeting};delete copy.recurrence;return copy;}
const meetingTask:TaskDto={...task,meetingId:MEETING,estimateMinutes:45,participants:[{membershipId:MEMBER_ID,role:'assignee',active:true,revision:1}],title:'Еженедельная синхронизация серии'};
function attendance(overrides:Partial<AttendanceDto>={}):AttendanceDto {return {id:ATTENDANCE,workspaceId:alpha.id,meetingId:MEETING,taskId:TASK_ID,membershipId:MEMBER_ID,revision:1,rosterActive:true,status:'unknown',postingState:'unconfirmed',minutes:null,confirmedMeetingRevision:null,workLog:null,...overrides};}
function routes(getMeeting:()=>MeetingDto|Promise<MeetingDto>):RouteTable {return {...tableRoutes(),[`GET ${rootPath}/tasks`]:()=>ok([meetingTask]),[`GET ${rootPath}/tasks/${TASK_ID}`]:()=>ok(meetingTask),[`GET ${rootPath}/tasks/${TASK_ID}/meeting`]:async()=>ok(await getMeeting()),[`GET ${rootPath}/tasks/${TASK_ID}/attendance`]:()=>ok([attendance()])};}
const seriesHref=`/w/${alpha.id}/projects/${PROJECT_ID}/week?period=${PERIOD_B}&series=${SERIES_ID}`;
function expectSeriesControls(dialog:HTMLElement) {
 for(const label of ["Meeting start","Meeting time zone","Meeting duration, minutes","Organizer"])expect(within(dialog).getByLabelText(label)).toBeDisabled();
 const attendee=within(dialog).getByRole('checkbox',{name:alphaMembers[0]?.displayName??''});expect(attendee).toBeDisabled();expect(attendee).toBeChecked();
 expect(within(dialog).queryByRole('button',{name:"Cancel meeting"})).not.toBeInTheDocument();expect(within(dialog).queryByRole('button',{name:"Restore meeting to schedule"})).not.toBeInTheDocument();
 expect(within(dialog).getByRole('link',{name:"Open meeting series"})).toHaveAttribute('href',seriesHref);
}

describe('recurring meeting occurrence in the P3a drawer',()=>{
 it('keeps planned schedule, roster and cancellation in the series while links, summary, actual details and attendance stay writable',async()=>{
  let current=recurringMeeting();const writes:UpdateMeetingInput[]=[];
  const {calls}=installFakeApi({...routes(()=>current),
   [`PATCH ${rootPath}/tasks/${TASK_ID}/meeting`]:request=>{const input=request.body as UpdateMeetingInput;writes.push(input);current={...current,revision:current.revision+1,...(input.joinUrl!==undefined?{joinUrl:input.joinUrl}:{}),...(input.summaryText!==undefined?{summaryText:input.summaryText}:{}),...(input.actualStartAt!==undefined?{actualStartAt:input.actualStartAt}:{}),...(input.actualDurationMinutes!==undefined?{actualDurationMinutes:input.actualDurationMinutes}:{})};return ok(current);},
   [`POST ${rootPath}/tasks/${TASK_ID}/attendance/confirm`]:()=>{current={...current,hasPostedAttendance:true};return ok({meeting:current,attendances:[attendance({status:'present',postingState:'active',minutes:45,revision:2,confirmedMeetingRevision:current.revision})]});}});
  const {user}=renderApp(`${tablePath}?task=${TASK_ID}&week=${PERIOD_A}`);const dialog=await screen.findByRole('dialog',{name:meetingTask.title});const summary=await within(dialog).findByLabelText("Meeting notes");
  expectSeriesControls(dialog);expect(within(dialog).getByLabelText("Meeting duration, minutes")).toHaveValue(45);expect(within(dialog).getByText("Recurring meeting")).toBeInTheDocument();
  expect(dialog).not.toHaveTextContent(SERIES_ID);expect(dialog).not.toHaveTextContent(INSTANCE_ID);expect(dialog).not.toHaveTextContent('first_valid_gap');
  await user.type(within(dialog).getByLabelText("Meeting link"),'https://meet.example.test/series');await user.type(summary,'Итог серии');await user.click(within(dialog).getByRole('button',{name:"Save meeting"}));
  await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0]).toEqual({expectedMeetingRevision:1,joinUrl:'https://meet.example.test/series',summaryText:'Итог серии'});
  await user.click(within(dialog).getByRole('tab',{name:"Attendance"}));const fill=await within(dialog).findByRole('button',{name:"Meeting followed the plan · fill details"});await waitFor(()=>expect(fill).toBeEnabled());await user.click(fill);await user.click(within(dialog).getByRole('button',{name:"Save actual details"}));
  await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1]).toEqual({expectedMeetingRevision:2,actualStartAt:PLANNED_START,actualDurationMinutes:45});
  const result=within(dialog).getByLabelText("Attendance outcome");await waitFor(()=>expect(result).toBeEnabled());await user.selectOptions(result,'present');await user.click(within(dialog).getByRole('button',{name:"Confirm selected person's attendance"}));
  await waitFor(()=>expect(calls.some(c=>c.path.endsWith('/attendance/confirm'))).toBe(true));
  expect(calls.find(c=>c.path.endsWith('/attendance/confirm'))?.body).toEqual({expectedMeetingRevision:3,periodId:PERIOD_B,rows:[{attendanceId:ATTENDANCE,expectedAttendanceRevision:1,expectedWorkLogRevision:null,kind:'confirm',status:'present',attributionBasis:'actual_meeting',reason:null}]});
  const writePaths=calls.filter(c=>c.method!=='GET').map(c=>`${c.method} ${c.path}`);
  expect(writePaths).toEqual([`PATCH ${rootPath}/tasks/${TASK_ID}/meeting`,`PATCH ${rootPath}/tasks/${TASK_ID}/meeting`,`POST ${rootPath}/tasks/${TASK_ID}/attendance/confirm`]);
  expect(calls.some(c=>c.path.includes('manual-period-work'))).toBe(false);
 });
 it('retains the known series ref when a same-revision metadata outcome omits it before the authoritative reread',async()=>{
  let current=recurringMeeting();let hold=false;const gate=deferred<undefined>();const writes:UpdateMeetingInput[]=[];
  const {calls}=installFakeApi({...routes(async()=>{if(hold)await gate.promise;return current;}),
   [`PATCH ${rootPath}/tasks/${TASK_ID}/meeting`]:request=>{const input=request.body as UpdateMeetingInput;writes.push(input);current={...current,revision:current.revision+1,...(input.summaryText!==undefined?{summaryText:input.summaryText}:{})};if(writes.length===1){hold=true;return ok(withoutSeries(current));}return ok(current);}});
  const {user}=renderApp(`${tablePath}?task=${TASK_ID}&week=${PERIOD_A}`);const dialog=await screen.findByRole('dialog',{name:meetingTask.title});const summary=await within(dialog).findByLabelText("Meeting notes");expectSeriesControls(dialog);
  const meetingReads=()=>calls.filter(c=>c.method==='GET'&&c.path===`${rootPath}/tasks/${TASK_ID}/meeting`).length;const readsBefore=meetingReads();
  await user.type(summary,'Итог');await user.click(within(dialog).getByRole('button',{name:"Save meeting"}));await waitFor(()=>expect(writes).toHaveLength(1));
  // The authoritative reread is in flight and held; only the ref-less outcome has been applied.
  await waitFor(()=>expect(meetingReads()).toBeGreaterThan(readsBefore));const save=within(dialog).getByRole('button',{name:"Save meeting"});await waitFor(()=>expect(save).toBeEnabled());
  expectSeriesControls(dialog);
  await user.type(summary,' — дополнение');await user.click(save);await waitFor(()=>expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({expectedMeetingRevision:2,summaryText:'Итог — дополнение'});
  await act(async()=>gate.resolve(undefined));await waitFor(()=>expect(save).toBeEnabled());
  expectSeriesControls(dialog);expect(writes).toHaveLength(2);
 });
});
