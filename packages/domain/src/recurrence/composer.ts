import {createMeetingInputSchema,type CreateMeetingInput,type MeetingDto,type RecurrenceCalendarState,type RecurrenceResolutionDto,type UpdateMeetingInput} from '@workloom/contracts';
import {DomainError,notFoundError} from '../errors.js';
import {createSingleMeetingInScope,updateSingleMeetingInScope} from '../meetings/service.js';
import type {PlanningTools} from '../planning/ports.js';
import {canonicalJson} from '../tasks/service.js';
import type {RecurrenceInstanceHeader,RecurrenceOccurrenceComposer,RecurrenceSeriesVersionRecord,RecurrenceTools,RecurrenceWriteScope} from './ports.js';

/** Internal signatures:
 * - createRecurrenceOccurrenceComposer(tools:RecurrenceTools):RecurrenceOccurrenceComposer
 * - occurrenceMeetingInput(header,version):CreateMeetingInput — template + reserved header resolution, never client input.
 * - reviseOccurrenceMeetingInScope(scope,header,target,tools):Promise<MeetingDto|null> — updates an existing materialized
 *   meeting through the extracted in-scope P3a update body (no public runner/guard). Callers classify protection first.
 */
export function occurrenceMeetingInput(header:RecurrenceInstanceHeader,version:Pick<RecurrenceSeriesVersionRecord,'template'|'schedule'>):CreateMeetingInput {
 const t=version.template;
 return {title:t.title,statusId:t.statusId,...(t.sectionId!==undefined?{sectionId:t.sectionId}:{}),plannedPeriodId:header.periodId,plannedStartAt:header.resolution.resolvedStartAt,
  timezone:version.schedule.timezone,plannedDurationMinutes:header.resolution.plannedDurationMinutes,organizerMembershipId:t.organizerMembershipId,attendeeMembershipIds:[...t.attendeeMembershipIds],
  ...(t.joinUrl!==undefined?{joinUrl:t.joinUrl}:{})};
}

/** Recurrence wrapper of the ordinary single-create body: identity comes only from the reserved header, the
 * authority is the server-built ValidatedGenerationAuthority of this tx, and the locator is attached in the same tx.
 */
export function createRecurrenceOccurrenceComposer(tools:RecurrenceTools):RecurrenceOccurrenceComposer {
 return {async createOccurrenceInScope(scope,header,authority,input) {
  if(authority.__workloomGenerationAuthority!=='validated'||authority.seriesId!==header.seriesId)throw new Error('A recurrence occurrence needs the validated authority of its own series.');
  if(input.plannedPeriodId!==header.periodId)throw new Error('A recurrence occurrence must stay in its reserved period.');
  const ws=scope.context.workspaceId,current=await scope.recurrence.findInstanceHeader(ws,header.seriesId,header.occurrenceKey);
  if(!current||current.id!==header.id||current.revision!==header.revision||current.periodId!==header.periodId||current.locator!==null||current.calendarState!=='scheduled')
   throw new DomainError('PREVIEW_STALE','A recurring occurrence changed. Restart preparation from the first chunk.');
  const creation=await createSingleMeetingInScope(scope,createMeetingInputSchema.parse(input),tools,{seriesId:current.seriesId,instanceId:current.id,occurrenceKey:current.occurrenceKey,nominalSequence:current.nominalSequence});
  const locator={meetingId:creation.meeting.id,taskId:creation.task.id,workPackageId:creation.task.workPackageId};
  await scope.recurrence.attachInstanceLocator(ws,current.id,current.revision,locator);
  // Trigger provenance (ctx) and generation-authorizer provenance stay separate in the audit trail.
  await scope.recordChange({entityType:'recurrence_instance',entityId:current.id,action:'materialized',entityRevision:current.revision+1,diff:{
   seriesId:current.seriesId,bindingId:current.bindingId,periodId:current.periodId,occurrenceKey:current.occurrenceKey,meetingId:locator.meetingId,
   triggerActorUserId:scope.context.actor.userId,triggerSource:scope.context.source,
   generationAuthorizerUserId:authority.authorizerUserId,generationAuthorizerMembershipId:authority.authorizerMembershipId,generationAuthorizationId:authority.authorizationId,generationAuthorizationRevision:authority.authorizationRevision,
  }});
  return {header:{...current,locator,revision:current.revision+1,updatedAt:scope.barrierAt.toISOString()},creation};
 }};
}

export interface OccurrenceMeetingTarget {
 readonly calendarState:RecurrenceCalendarState;readonly resolution:RecurrenceResolutionDto;
 readonly version:Pick<RecurrenceSeriesVersionRecord,'template'|'schedule'>;
}
/** Applies the current recurrence schedule/template to an existing composition. It changes only planned schedule,
 * roster, organizer, link, state and title; never actuals, recording/summary, attendance statuses, categories or plans.
 */
export async function reviseOccurrenceMeetingInScope(scope:RecurrenceWriteScope,header:RecurrenceInstanceHeader,target:OccurrenceMeetingTarget,tools:Pick<PlanningTools,'newId'>,fields:'schedule'|'calendar'|'all'='all'):Promise<MeetingDto|null> {
 if(!header.locator)return null;
 // Move/skip keep the existing planned roster. Reset/restore inherit the effective calendar only; ordinary task/material metadata is preserved.
 const all=fields==='all',calendar=fields!=='schedule';
 const ws=scope.context.workspaceId,taskId=header.locator.taskId,m=await scope.repository.findMeetingByTask(ws,taskId),task=await scope.repository.tasks.findTask(ws,taskId);
 if(!m||!task)throw notFoundError();
 const t=target.version.template,roster=(await scope.repository.listAttendance(ws,m.id)).filter(a=>a.rosterActive).map(a=>a.membershipId).sort();
 const patch:{-readonly [K in keyof UpdateMeetingInput]?:UpdateMeetingInput[K]}={};
 const scheduled=target.calendarState==='scheduled';
 if(scheduled&&Date.parse(target.resolution.resolvedStartAt)!==Date.parse(m.plannedStartAt))patch.plannedStartAt=target.resolution.resolvedStartAt;
 if(calendar&&scheduled&&target.version.schedule.timezone!==m.timezone)patch.timezone=target.version.schedule.timezone;
 if(calendar&&scheduled&&target.resolution.plannedDurationMinutes!==m.plannedDurationMinutes)patch.plannedDurationMinutes=target.resolution.plannedDurationMinutes;
 if(calendar&&scheduled&&t.organizerMembershipId!==m.organizerMembershipId)patch.organizerMembershipId=t.organizerMembershipId;
 if(calendar&&scheduled&&canonicalJson([...t.attendeeMembershipIds].sort())!==canonicalJson(roster))patch.attendeeMembershipIds=[...t.attendeeMembershipIds];
 if(all&&scheduled&&t.joinUrl!==undefined&&t.joinUrl!==m.joinUrl)patch.joinUrl=t.joinUrl;
 if(target.calendarState!==m.state)patch.state=target.calendarState;
 let meeting=m;
 if(Object.keys(patch).length)meeting=await updateSingleMeetingInScope(scope,taskId,{...patch,expectedMeetingRevision:m.revision,expectedParticipantsRevision:task.participantsRevision,expectedWorkPackageRevision:task.workPackageRevision},tools);
 if(all&&scheduled&&(t.title!==task.title||t.statusId!==task.statusId||(t.sectionId??null)!==task.sectionId)){
  const current=await scope.repository.tasks.findTask(ws,taskId);if(!current)throw notFoundError();
  const fields=['title','statusId','sectionId'].filter(field=>field==='title'?t.title!==current.title:field==='statusId'?t.statusId!==current.statusId:(t.sectionId??null)!==current.sectionId);
  const now=scope.barrierAt.toISOString(),next={...current,title:t.title,statusId:t.statusId,sectionId:t.sectionId??null,revision:current.revision+1,updatedAt:now};
  await scope.repository.tasks.saveTaskCore(next);
  await scope.recordChange({entityType:'task',entityId:taskId,action:'updated',entityRevision:next.revision,diff:{fields,seriesId:header.seriesId,instanceId:header.id},outbox:{type:'task.updated',payload:{workspaceId:ws,taskId,revision:next.revision}}});
 }
 return meeting;
}
