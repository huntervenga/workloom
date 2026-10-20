import { fieldPolicyBlock, fieldPolicyError, type FieldPolicyBlock } from '../fields/policy.js';
import { preflightTaskFieldValueInScope } from '../fields/service.js';
import { RECURRENCE_LIMITS, idSchema, bulkChangesForTask, type TaskFieldData, type FreezeScope, type PlanBaselineDto, type PlanningPeriodDto, type PlanningSnapshotDto } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import { DomainError } from '../errors.js';
import { RECURRENCE_PREREQUISITE_BY_COMMAND, type RecurrenceCensusAssessment } from '../recurrence/ports.js';
import { canonicalJson } from '../tasks/service.js';
import type { CommittedPlanningRejection, PlanningMutationGuard, PlanningMutationIntent, PlanningRepository, PlanningTools, PlanningWriteScope } from './ports.js';

function rule(message:string):DomainError {return new DomainError('DOMAIN_VALIDATION_FAILED',message);}
/** Public controlled 409; clients recover through GET recurrence-readiness, not through these bounded details. */
export function materializationRequiredError(periodId:string,assessment:Pick<RecurrenceCensusAssessment,'status'|'missingCount'>):DomainError {
  return new DomainError('MATERIALIZATION_REQUIRED','Recurring meetings of this period must be prepared before it can be frozen. Check the period readiness.',{details:{periodId,state:assessment.status,missingCount:assessment.missingCount}});
}
function requireCensus(scope:PlanningWriteScope):PlanningWriteScope['recurrenceCensus'] {
  // Fail closed for a composition that has not bound the mandatory census yet; never a silent no-op.
  if(!scope.recurrenceCensus)throw new Error('Every planning write scope must bind the mandatory recurrence census.');
  return scope.recurrenceCensus;
}
function record(value:unknown):Record<string,unknown> {return typeof value==='object'&&value!==null?value as Record<string,unknown>:{};}
function sorted<T extends {id:string}>(rows:T[]):T[] {return [...rows].sort((a,b)=>a.id.localeCompare(b.id));}

/** The full preview source is read from one repeatable-read snapshot or under the write barrier. */
export async function captureFreezeSnapshot(repo:PlanningRepository,period:PlanningPeriodDto,scope:FreezeScope,memberId:string|null):Promise<PlanningSnapshotDto> {
  const ws=period.workspaceId;
  const [sources,current,baselines]=await Promise.all([repo.captureProject(ws,period.projectId),repo.listCommitments(ws,period.id),repo.listBaselines(ws,period.id)]);
  const personal=baselines.filter(b=>b.scope==='self').sort((a,b)=>BigInt(a.changeSeq)<BigInt(b.changeSeq)?-1:BigInt(a.changeSeq)>BigInt(b.changeSeq)?1:a.frozenAt.localeCompare(b.frozenAt)||a.id.localeCompare(b.id));
  const own=scope==='self'?personal.filter(b=>b.membershipId===memberId):personal;
  const frozenMembers=new Set(own.map(b=>b.membershipId));
  const commitments=[...own.flatMap(b=>b.snapshot.commitments),...current.filter(c=>c.state==='active'&&c.classification==='planned'&&!frozenMembers.has(c.membershipId)&&(scope==='project'||c.membershipId===memberId))];
  const packageIds=new Set(commitments.map(c=>c.workPackageId));
  const inheritedPackages=own.flatMap(b=>b.snapshot.packages);
  const packages=sources.packages.filter(p=>packageIds.has(p.id)).map(p=>inheritedPackages.find(old=>old.id===p.id)??p);
  const inheritedTasks=own.flatMap(b=>b.snapshot.tasks);
  const tasks=sources.tasks.filter(t=>packageIds.has(t.workPackageId)).map(t=>inheritedTasks.find(old=>old.id===t.id)??t);
  const taskIds=new Set(tasks.map(t=>t.id));
  const inheritedDefinitions=own.flatMap(b=>b.snapshot.fieldDefinitions);
  const fields=sources.fields.filter(f=>period.protectedFieldIds.includes(f.id)).map(f=>inheritedDefinitions.find(old=>old.id===f.id)??f);
  const inheritedValues=own.flatMap(b=>b.snapshot.fieldValues);
  const values=tasks.flatMap(t=>fields.map(f=>inheritedValues.find(v=>v.taskId===t.id&&v.fieldId===f.id)??{taskId:t.id,fieldId:f.id,value:sources.values.find(v=>v.taskId===t.id&&v.fieldId===f.id)??null}));
  const currentMeetings=(await repo.listMeetings(ws,period.projectId)).filter(m=>m.plannedPeriodId===period.id&&packageIds.has(m.workPackageId));
  const inheritedMeetings=own.flatMap(b=>b.snapshot.meetings??[]);
  const meetingSnapshots=await Promise.all(currentMeetings.map(async meeting=>{
    const inherited=inheritedMeetings.find(m=>m.meeting.id===meeting.id);
    return {meeting:inherited?.meeting??meeting,attendees:inherited?.attendees??(await repo.listAttendance(ws,meeting.id)).map(a=>({id:a.id,membershipId:a.membershipId,revision:a.revision,rosterActive:a.rosterActive})),commitmentIds:commitments.filter(c=>c.workPackageId===meeting.workPackageId).map(c=>c.id).sort()};
  }));
  const currentCalendar=await repo.captureRecurrenceSnapshot(period,scope,memberId);
  const inheritedCalendars=own.flatMap(b=>b.snapshot.recurrence?[b.snapshot.recurrence]:[]);
  const calendarBase=currentCalendar??inheritedCalendars[0];
  const calendarEntries=new Map<string,NonNullable<PlanningSnapshotDto['recurrence']>['census'][number]>();
  for(const section of [...inheritedCalendars,...(currentCalendar?[currentCalendar]:[])])for(const entry of section.census)if(!calendarEntries.has(entry.instanceId))calendarEntries.set(entry.instanceId,entry);
  const calendarBindings=new Map<string,NonNullable<PlanningSnapshotDto['recurrence']>['bindings'][number]>();
  for(const section of [...inheritedCalendars,...(currentCalendar?[currentCalendar]:[])])for(const binding of section.bindings)calendarBindings.set(binding.bindingId,binding);
  const recurrence=calendarBase?{...calendarBase,bindings:[...calendarBindings.values()].sort((a,b)=>a.bindingId.localeCompare(b.bindingId)),census:[...calendarEntries.values()].sort((a,b)=>a.seriesId.localeCompare(b.seriesId)||a.occurrenceKey.localeCompare(b.occurrenceKey))}:undefined;
  return {
    ...(recurrence?{recurrence}:{}),
    schemaVersion:1,period,commitments:sorted(commitments),packages:sorted(packages),projectPackageIds:sources.packages.map(p=>p.id).sort(),
    tasks:sorted(tasks.filter(t=>taskIds.has(t.id))),memberships:sorted(sources.memberships.map(m=>own.find(b=>b.membershipId===m.id)?.snapshot.memberships.find(old=>old.id===m.id)??m)),
    fieldDefinitions:sorted(fields),fieldValues:values.sort((a,b)=>(a.taskId+a.fieldId).localeCompare(b.taskId+b.fieldId)),
    sourcePersonalBaselineIds:own.map(b=>b.id).sort(),meetings:meetingSnapshots.sort((a,b)=>a.meeting.id.localeCompare(b.meeting.id)),
  };
}
export async function freezePreviewHash(tools:Pick<PlanningTools,'newId'|'digest'>,repo:PlanningRepository,ctx:CommandContext,periodId:string,scope:FreezeScope,memberId:string|null,snapshot:PlanningSnapshotDto):Promise<string> {
  const sources=await repo.captureProject(ctx.workspaceId,snapshot.period.projectId);
  const accessManifest={actorUserId:ctx.actor.userId,permissionEpoch:await repo.tasks.permissionEpoch(ctx.workspaceId),activeMembershipIds:[...sources.activeMembershipIds].sort()};
  return tools.digest(canonicalJson({version:1,periodId,scope,memberId,snapshot,accessManifest}));
}

/** Returns an existing immutable freeze or inserts its whole document and all locks atomically. */
export async function performFreeze(scope:PlanningWriteScope,period:PlanningPeriodDto,kind:FreezeScope,memberId:string|null,mode:'manual'|'cutoff',tools:Pick<PlanningTools,'newId'|'digest'>):Promise<PlanBaselineDto> {
  const repo=scope.repository,ws=period.workspaceId;
  const existing=(await repo.listBaselines(ws,period.id)).find(b=>b.scope===kind&&b.membershipId===memberId);
  if(existing)return existing;
  // Both scopes require a complete period census; personal locks remain restricted to their roster.
  const ensured=await requireCensus(scope).ensurePeriod(period,{maxCreates:RECURRENCE_LIMITS.maxRealCreatesPerChunk,reason:'freeze',cursor:null,bindingId:null});
  if(ensured.status!=='complete')throw materializationRequiredError(period.id,{status:ensured.status,missingCount:ensured.remainingCount});
  if(kind==='project') {
    // Each person's original freeze remains independently inspectable and can drive a personal report.
    const sources=await repo.captureProject(ws,period.projectId);
    const commitments=await repo.listCommitments(ws,period.id);
    const memberIds=new Set([...sources.memberships.filter(m=>sources.activeMembershipIds.includes(m.id)&&m.role!=='viewer').map(m=>m.id),...commitments.filter(c=>c.state==='active'&&c.classification==='planned').map(c=>c.membershipId)]);
    for(const id of [...memberIds].sort())await performFreeze(scope,period,'self',id,mode,tools);
    period=(await repo.findPeriod(ws,period.id))??period;
  }
  let snapshot=await captureFreezeSnapshot(repo,period,kind,memberId);
  const baselineId=tools.newId(),now=scope.barrierAt.toISOString();
  const newPackages=[];
  for(const p of snapshot.packages) {
    const observation=await repo.findPackageObservation(ws,p.id);
    const known=await repo.findPackageBaselineForPackage(ws,p.id);
    if(!observation) {
      const knownId=p.estimateMinutes===null?null:tools.newId();
      newPackages.push({package:p,knownId});
      if(knownId)p.packageBaselineId=knownId;
    } else p.packageBaselineId=known?.id??null;
  }
  // A fresh immutable object: nested arrays are never appended after insertion.
  snapshot=JSON.parse(canonicalJson(snapshot)) as PlanningSnapshotDto;
  const change=await scope.recordChange({entityType:'plan_baseline',entityId:baselineId,action:'frozen',entityRevision:1,diff:{periodId:period.id,scope:kind,membershipId:memberId,mode,commitmentIds:snapshot.commitments.map(c=>c.id)},outbox:{type:'plan.frozen',payload:{periodId:period.id,baselineId,scope:kind,membershipId:memberId}}});
  const baseline:PlanBaselineDto={id:baselineId,workspaceId:ws,projectId:period.projectId,periodId:period.id,scope:kind,membershipId:memberId,mode,requestedCutoffAt:period.cutoffAt,frozenAt:now,actorUserId:scope.context.actor.userId,source:scope.context.source,changeSeq:change.changeSeq.toString(),snapshot};
  await repo.insertBaseline(baseline);
  for(const entry of newPackages) {
    const p=entry.package;
    await repo.insertPackageObservation({workspaceId:ws,projectId:period.projectId,workPackageId:p.id,estimateMinutes:p.estimateMinutes,packageRevision:p.revision,baselineId});
    if(entry.knownId!==null&&p.estimateMinutes!==null)await repo.insertPackageBaseline({id:entry.knownId,workspaceId:ws,projectId:period.projectId,workPackageId:p.id,estimateMinutes:p.estimateMinutes,sourcePackageRevision:p.revision,sourceBaselineId:baselineId,acceptedAt:now,provenance:'first_known_plan_freeze'});
  }
  const locks=[];
  const common={workspaceId:ws,projectId:period.projectId,baselineId};
  for(const c of snapshot.commitments)locks.push({...common,id:tools.newId(),kind:'commitment' as const,commitmentId:c.id,workPackageId:null,taskId:null,fieldId:null});
  if(period.protectEstimate)for(const p of snapshot.packages)locks.push({...common,id:tools.newId(),kind:'estimate' as const,workPackageId:p.id,taskId:null,fieldId:null,commitmentId:null});
  for(const v of snapshot.fieldValues)locks.push({...common,id:tools.newId(),kind:'custom_value' as const,taskId:v.taskId,fieldId:v.fieldId,workPackageId:null,commitmentId:null});
  await repo.insertLocks(locks);
  for(const entry of snapshot.meetings??[])await repo.insertMeetingLock(ws,entry.meeting.id,baselineId,tools.newId());
  if(snapshot.recurrence) {
    // Calendar locks follow instance identity (cancelled header-only rows included); a real occurrence meeting also
    // gets the existing P3a schedule/roster lock so generic meeting/task commands cannot rewrite its original calendar.
    const census=requireCensus(scope);
    await census.insertCalendarLocks(census.calendarLocksFor(snapshot.recurrence,baselineId,period.projectId));
    const locked=new Set((snapshot.meetings??[]).map(m=>m.meeting.id));
    for(const entry of snapshot.recurrence.census)if(entry.meetingId!==null&&!locked.has(entry.meetingId)){locked.add(entry.meetingId);await repo.insertMeetingLock(ws,entry.meetingId,baselineId,tools.newId());}
  }
  const current=(await repo.findPeriod(ws,period.id))??period;
  await repo.savePeriod({...current,revision:current.revision+1,updatedAt:now,...(kind==='project'?{state:'frozen' as const,projectBaselineId:baselineId}:{})});
  return baseline;
}

export function isCommittedPlanningRejection(value:unknown):value is CommittedPlanningRejection {
  const v=record(value),details=record(v['details']);
  return v['__workloomPlanningOutcome']==='rejected'&&(v['code']==='FIELD_LOCKED'||v['code']==='PREVIEW_STALE')&&details['committed']===true&&(details['policyReason']===undefined||details['policyReason']==='deadline'||details['policyReason']==='change_limit')&&Array.isArray(details['baselineIds'])&&details['baselineIds'].every(id=>typeof id==='string'&&idSchema.safeParse(id).success);
}
export function unwrapPlanningOutcome<T>(value:T|CommittedPlanningRejection):T {
  if(isCommittedPlanningRejection(value))throw new DomainError(value.code,value.code==='FIELD_LOCKED'?(value.details.policyReason?fieldPolicyError(value.details.policyReason).message:'This value is protected by an immutable planning baseline.'):'A cutoff freeze changed the preview. Review the saved baseline and preview again.',{details:value.details});
  return value;
}
function never(value:never):never {throw new Error(`Unhandled planning mutation intent: ${String(value)}`);}

/** Mandatory shared pre-handler policy: all command families are exhaustively classified.
 * Order under the barrier (docs16 §8): typed recovery bypass → affected footprint → due freezes (affected periods
 * ensure their census or fail closed; unrelated periods freeze only when already complete) → complete affected census.
 */
export function createPlanningMutationGuard(scope:PlanningWriteScope,tools:Pick<PlanningTools,'newId'|'digest'>):PlanningMutationGuard {
  return {async check(intent:PlanningMutationIntent) {
    // Comments and own display preferences are explicitly inert: no planning/census work.
    if(intent.family==='comment'||intent.family==='table_preference'||intent.family==='cutoff'||intent.family==='generic_report'||intent.family==='planning_check')return null;
    const repo=scope.repository,ws=scope.context.workspaceId,census=requireCensus(scope);
    // materializePeriod and authorizeGeneration bypass every due-freeze loop; their handlers create only approved
    // target-period census or replace grant metadata, and never depend on a revoked old grant.
    if(intent.family==='dependency'&&intent.command==='graph.layout.set')return null;
    if(intent.family==='import'&&intent.command==='import.csv.stage')return null;
    if(intent.family==='recurrence'&&RECURRENCE_PREREQUISITE_BY_COMMAND[intent.command]!=='full_due_freeze')return null;
    const footprint=await census.resolveAffectedProjects(intent);
    const affected=new Set(footprint.kind==='projects'?footprint.projectIds:[]);
    const due=(await repo.listPeriods(ws)).filter(p=>p.state==='planning'&&Date.parse(p.cutoffAt)<=scope.barrierAt.getTime());
    const newlyFrozen:string[]=[],frozenDue:PlanningPeriodDto[]=[];
    for(const period of due) {
      // An unrelated project's pending/blocked census stays visible in readiness and never makes this write unwritable.
      if(!affected.has(period.projectId)&&(await census.assessPeriod(period)).status!=='complete')continue;
      newlyFrozen.push((await performFreeze(scope,period,'project',null,'cutoff',tools)).id);frozenDue.push(period);
    }
    await census.requireCompleteCensus(footprint);
    const locks=await repo.listLocks(ws);
    const input=record(intent.input),target=record(intent.target);
    let blocked:string[]=[];
    let policyReason:FieldPolicyBlock|null=null;
    const policyCheck=async(fieldId:string,taskId:string|null,value:unknown,expectedDefinitionRevision?:number,expectedRevision?:number)=>{
      const policy=await repo.fields.policies.find(ws,fieldId);
      if(policy===null)return null;
      if(taskId!==null) {
        const prepared=await preflightTaskFieldValueInScope({...scope,repository:repo.fields},taskId,fieldId,
          {expectedRevision:expectedRevision??-1,expectedDefinitionRevision:expectedDefinitionRevision??-1,value:value as TaskFieldData},{deferPolicy:true});
        if(prepared.current!==null&&canonicalJson(prepared.current.value)===canonicalJson(prepared.parsed.value))return null;
      }
      return fieldPolicyBlock(repo.fields.policies,policy,taskId,scope.context.actor.userId,scope.barrierAt);
    };
    switch(intent.family) {
      case 'task_placement': {
        // Metadata-only: due freezes/census still cover canonical home and target project.
        switch(intent.command){
          case 'task.project.attach':case 'task.project.update':case 'task.project.detach':case 'task.project.restore':break;
          default:never(intent);
        }
        const task=await repo.tasks.findTask(ws,intent.target.taskId);
        if(task?.meetingId)throw rule('Meeting and recurrence placements are outside this slice.');
        break;
      }
      case 'import':
        if(intent.command==='import.project.apply') {
          if(!await intent.previewMatches())return {__workloomPlanningOutcome:'rejected',code:'PREVIEW_STALE',details:{committed:true,baselineIds:[...new Set(newlyFrozen)].sort()}};
          for(const candidate of intent.fieldPolicyCandidates) {
            policyReason=await policyCheck(candidate.fieldId,null,candidate.value);
            if(policyReason)break;
          }
        }
        break;
      case 'schedule':
        if(!await intent.previewMatches())return {__workloomPlanningOutcome:'rejected',code:'PREVIEW_STALE',details:{committed:true,baselineIds:[...new Set(newlyFrozen)].sort()}};
        break;
      case 'task':
        switch(intent.command) {
          case 'task.update': {
            const task=intent.target===null?null:await repo.tasks.findTask(ws,intent.target);
            if(task&&input['estimateMinutes']!==undefined)blocked=locks.filter(l=>l.kind==='estimate'&&l.workPackageId===task.workPackageId).map(l=>l.baselineId);
            if(task?.meetingId&&['participantMembershipIds','responsibleMembershipId','startDate','dueDate','parentTaskId','estimateMinutes'].some(k=>input[k]!==undefined)) {
              const meetingLocks=await repo.listMeetingLocks(ws,task.meetingId);
              if(meetingLocks.length)blocked.push(...meetingLocks.map(l=>l.baselineId));
              else throw rule('Use the meeting command to change its roster, schedule or package.');
            }
            if(task&&input['parentTaskId']!==undefined) {
              const sources=await repo.captureProject(ws,task.projectId);
              const parents=new Map(sources.tasks.map(t=>[t.id,t.id===task.id?input['parentTaskId'] as string|null:t.parentTaskId]));
              const commitments=(await Promise.all((await repo.listPeriods(ws,task.projectId)).map(p=>repo.listCommitments(ws,p.id)))).flat().filter(c=>c.state==='active');
              for(const c of commitments)for(const a of c.allocations) {
                let at=parents.get(a.taskId);const seen=new Set<string>();
                while(at) {
                  if(seen.has(at))break;seen.add(at);
                  if(c.allocations.some(other=>other.taskId===at))throw rule('Reparenting would allocate both an ancestor and its descendant in one commitment.');
                  at=parents.get(at);
                }
              }
            }
            break;
          }
          // They still run overdue freeze first. These edits do not rewrite protected value identities.
          // task.move changes order/section, or current assignee/status; protected values and lineage stay unchanged.
          case 'project.create':case 'project.update':case 'section.create':case 'section.update':
          case 'tag.create':case 'tag.update':break;
          case 'task.move': {
            if(input['responsibleMembershipId']!==undefined) {
              const task=intent.target===null?null:await repo.tasks.findTask(ws,intent.target);
              if(task?.meetingId&&input['responsibleMembershipId']!==task.responsibleMembershipId) {
                const meetingLocks=await repo.listMeetingLocks(ws,task.meetingId);
                if(meetingLocks.length)blocked.push(...meetingLocks.map(l=>l.baselineId));
                else throw rule('Use the meeting command to change its roster, schedule or package.');
              }
            }
            break;
          }
          case 'task.create': {
            if(typeof input['parentTaskId']==='string'&&input['workScope']!=='added_scope') {
              const parent=await repo.tasks.findTask(ws,input['parentTaskId']);
              if(parent?.meetingId)throw rule('Meeting preparation needs an explicit separate work package.');
            }
            break;
          }
          case 'task.archive':case 'task.restore': {
            const task=intent.target===null?null:await repo.tasks.findTask(ws,intent.target);
            if(task?.meetingId)throw rule('Use meeting cancellation or restore.');
            break;
          }
          default:never(intent);
        }
        break;
      case 'task_bulk': {
        // Same meeting roster/calendar policy as task.update, classified for every row before any proposal.
        for(const row of intent.input.tasks) {
          const task=await repo.tasks.findTask(ws,row.taskId);
          const changes=bulkChangesForTask(intent.input,row.taskId);
          if(task && changes.estimateMinutes !== undefined) {
            blocked.push(...locks.filter(lock => lock.kind === 'estimate' && lock.workPackageId === task.workPackageId).map(lock => lock.baselineId));
          }
          const custom = changes.customField;
          if (task && custom) {
            blocked.push(...locks.filter(lock => lock.kind === 'custom_value' && lock.taskId === task.id && lock.fieldId === custom.fieldId).map(lock => lock.baselineId));
          }
          if(task?.meetingId) {
            const meetingLocks=await repo.listMeetingLocks(ws,task.meetingId);
            if(meetingLocks.length)blocked.push(...meetingLocks.map(l=>l.baselineId));
            else throw rule('Use the meeting command to change its roster, schedule or package.');
          }
        }
        for (const row of intent.input.tasks) {
          const custom = bulkChangesForTask(intent.input, row.taskId).customField;
          if (!custom) continue;
          const definition = await repo.fields.findField(ws, custom.fieldId);
          if (definition?.projectId === intent.input.projectId && definition.locked) return {
            __workloomPlanningOutcome: 'rejected', code: 'FIELD_LOCKED',
            details: { committed: true, baselineIds: [...new Set(newlyFrozen)].sort() },
          };
        }
        if (!blocked.length) for (const row of intent.input.tasks) {
          const custom = bulkChangesForTask(intent.input, row.taskId).customField;
          if (!custom) continue;
          policyReason = await policyCheck(custom.fieldId, row.taskId, custom.value, custom.expectedDefinitionRevision, row.expectedFieldValueRevision);
          if (policyReason) break;
        }
        break;
      }
      case 'duplication': {
        if(intent.command==='task.duplicate') {
          const source=await repo.tasks.findTask(ws,intent.target.sourceId);
          const parent=source?.parentTaskId?await repo.tasks.findTask(ws,source.parentTaskId):null;
          if(parent?.meetingId&&source?.workPackageId===parent.workPackageId)throw rule('Meeting preparation needs an explicit separate work package.');
        }
        // New identities have no old baseline/value locks. Existing definition and deadline rules still apply.
        for(const selected of intent.fieldPolicyCandidates) {
          const definition=await repo.fields.findField(ws,selected.fieldId);
          if(definition?.projectId===intent.target.projectId&&definition.locked)return {__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[...new Set(newlyFrozen)].sort()}};
        }
        for(const selected of intent.fieldPolicyCandidates) {
          policyReason=await policyCheck(selected.fieldId,null,selected.value,selected.expectedDefinitionRevision,0);
          if(policyReason)break;
        }
        break;
      }
      case 'task_row': {
        // Ordinary new-task metadata plus first values: no protected task, package, value or fact exists yet.
        // The composer guards an existing protected commitment separately before it creates anything.
        const row=intent.input.task;
        if(typeof row.parentTaskId==='string'&&row.workScope!=='added_scope') {
          const parent=await repo.tasks.findTask(ws,row.parentTaskId);
          if(parent?.meetingId)throw rule('Meeting preparation needs an explicit separate work package.');
        }
        // A manually locked definition wins before revision/archival/type, as in field.value.set. Missing or
        // cross-project definitions are service preflight errors, never a committed rejection.
        for(const selected of intent.input.fields??[]) {
          const definition=await repo.fields.findField(ws,selected.fieldId);
          if(definition?.projectId===row.projectId&&definition.locked)return {__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[...new Set(newlyFrozen)].sort()}};
        }
        for(const selected of intent.input.fields??[]) {
          policyReason=await policyCheck(selected.fieldId,null,selected.value,selected.expectedDefinitionRevision,0);
          if(policyReason)break;
        }
        break;
      }
      case 'field':
        switch(intent.command) {
          case 'field.value.set':case 'field.value.exception': {
            blocked=locks.filter(l=>l.kind==='custom_value'&&l.taskId===target['taskId']&&l.fieldId===target['fieldId']).map(l=>l.baselineId);
            if(!blocked.length&&intent.command==='field.value.set'&&typeof target['fieldId']==='string'&&typeof target['taskId']==='string') {
              policyReason=await policyCheck(target['fieldId'],target['taskId'],input['value'],input['expectedDefinitionRevision'] as number,input['expectedRevision'] as number);
            }
            break;
          }
          case 'field.policy.set':case 'field.create':case 'field.update':case 'field.option.create':case 'field.option.update':case 'field.columns.update':break;
          default:never(intent);
        }
        break;
      case 'planning':
        switch(intent.command) {
          case 'commitment.update':blocked=locks.filter(l=>l.kind==='commitment'&&l.commitmentId===target['commitmentId']).map(l=>l.baselineId);break;
          case 'period.update': {
            const id=target['periodId'];
            if(typeof id==='string')blocked=(await repo.listBaselines(ws,id)).map(b=>b.id);
            break;
          }
          case 'work.set': {
            if(typeof target['taskId']==='string'&&(await repo.findMeetingByTask(ws,target['taskId'])))throw rule('Use attendance confirmation for a meeting task.');
            break;
          }
          case 'period.create':case 'commitment.create':case 'plan.freeze':case 'report.create':break;
          default:never(intent);
        }
        break;
      case 'meeting':
        switch(intent.command) {
          case 'meeting.update': {
            if(typeof target['taskId']==='string') {
              const meeting=await repo.findMeetingByTask(ws,target['taskId']);
              // A recurring occurrence keeps its calendar in the series: move/skip/restore go through exceptions.
              if(meeting?.recurrence&&((typeof input['plannedStartAt']==='string'&&Date.parse(input['plannedStartAt'])!==Date.parse(meeting.plannedStartAt))||(input['timezone']!==undefined&&input['timezone']!==meeting.timezone)||(input['state']!==undefined&&input['state']!==meeting.state)))
                throw rule('Use the recurring meeting exception to move, skip or restore this occurrence.');
              if(meeting) {
                const rosterChanged=Array.isArray(input['attendeeMembershipIds'])&&canonicalJson([...input['attendeeMembershipIds']].sort())!==canonicalJson((await repo.listAttendance(ws,meeting.id)).filter(a=>a.rosterActive).map(a=>a.membershipId).sort());
                const plannedChanged=rosterChanged||(typeof input['plannedStartAt']==='string'&&Date.parse(input['plannedStartAt'])!==Date.parse(meeting.plannedStartAt))||(input['timezone']!==undefined&&input['timezone']!==meeting.timezone)||(input['plannedDurationMinutes']!==undefined&&input['plannedDurationMinutes']!==meeting.plannedDurationMinutes)||(input['organizerMembershipId']!==undefined&&input['organizerMembershipId']!==meeting.organizerMembershipId);
                if(meeting.recurrence&&(plannedChanged||(input['state']!==undefined&&input['state']!==meeting.state)))throw rule('Use the recurrence series or exception commands to change planned time, duration, organizer, roster or state.');
                if(plannedChanged){blocked=(await repo.listMeetingLocks(ws,meeting.id)).map(l=>l.baselineId);if(meeting.hasPostedAttendance&&!blocked.length)return {__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:newlyFrozen}};}
              }
            }
            break;
          }
          case 'meeting.plan.apply': {
            if(typeof target['taskId']==='string') {
              const meeting=await repo.findMeetingByTask(ws,target['taskId']);
              const rows=Array.isArray(input['rows'])?input['rows'].map(record):[];
              if(meeting){const current=await repo.listCommitments(ws,meeting.plannedPeriodId);const ids=current.filter(c=>c.workPackageId===meeting.workPackageId&&rows.some(r=>r['membershipId']===c.membershipId)).map(c=>c.id);blocked=locks.filter(l=>l.commitmentId!==null&&ids.includes(l.commitmentId)).map(l=>l.baselineId);}
            }break;
          }
          case 'meeting.create':case 'meeting.attendance.confirm':break;
          default:never(intent);
        }
        break;
      case 'category':
        switch(intent.command) {
          case 'category.binding.update':case 'work.recategorize':case 'work_type_report.create':break;
          default:never(intent);
        }
        break;
      case 'dependency':
        switch(intent.command){case 'dependency.create':case 'dependency.update':case 'dependency.policy.update':case 'graph.layout.set':break;default:never(intent);}
        break;
      case 'recurrence':
        switch(intent.command) {
          // Protected recurrence targets (past/done/posted/frozen/cross-period) are classified by the recurrence
          // handlers and reject the whole command; recovery commands returned above.
          case 'recurrence.series.create':case 'recurrence.series.edit':case 'recurrence.series.state':case 'recurrence.periods.add':
          case 'recurrence.exception.set':case 'recurrence.generation.authorize':case 'recurrence.period.materialize':break;
          default:never(intent);
        }
        break;
      default:never(intent);
    }
    if(!blocked.length&&newlyFrozen.length&&intent.family==='meeting'&&intent.command==='meeting.plan.apply'&&typeof target['taskId']==='string'){const meeting=await repo.findMeetingByTask(ws,target['taskId']);if(meeting&&frozenDue.some(p=>p.id===meeting.plannedPeriodId))return {__workloomPlanningOutcome:'rejected',code:'PREVIEW_STALE',details:{committed:true,baselineIds:[...new Set(newlyFrozen)].sort()}};}
    if(!blocked.length&&policyReason)return {__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[...new Set(newlyFrozen)].sort(),policyReason}};
    return blocked.length?{__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[...new Set([...blocked,...newlyFrozen])].sort()}}:null;
  }};
}
