import { idSchema, type FreezeScope, type PlanBaselineDto, type PlanningPeriodDto, type PlanningSnapshotDto } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import type { CommittedPlanningRejection, PlanningMutationGuard, PlanningMutationIntent, PlanningRepository, PlanningTools, PlanningWriteScope } from './ports.js';

function rule(message:string):DomainError {return new DomainError('DOMAIN_VALIDATION_FAILED',message);}
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
  return {
    schemaVersion:1,period,commitments:sorted(commitments),packages:sorted(packages),projectPackageIds:sources.packages.map(p=>p.id).sort(),
    tasks:sorted(tasks.filter(t=>taskIds.has(t.id))),memberships:sorted(sources.memberships.map(m=>own.find(b=>b.membershipId===m.id)?.snapshot.memberships.find(old=>old.id===m.id)??m)),
    fieldDefinitions:sorted(fields),fieldValues:values.sort((a,b)=>(a.taskId+a.fieldId).localeCompare(b.taskId+b.fieldId)),
    sourcePersonalBaselineIds:own.map(b=>b.id).sort(),
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
  const current=(await repo.findPeriod(ws,period.id))??period;
  await repo.savePeriod({...current,revision:current.revision+1,updatedAt:now,...(kind==='project'?{state:'frozen' as const,projectBaselineId:baselineId}:{})});
  return baseline;
}

export function isCommittedPlanningRejection(value:unknown):value is CommittedPlanningRejection {
  const v=record(value),details=record(v['details']);
  return v['__workloomPlanningOutcome']==='rejected'&&v['code']==='FIELD_LOCKED'&&details['committed']===true&&Array.isArray(details['baselineIds'])&&details['baselineIds'].every(id=>typeof id==='string'&&idSchema.safeParse(id).success);
}
export function unwrapPlanningOutcome<T>(value:T|CommittedPlanningRejection):T {
  if(isCommittedPlanningRejection(value))throw new DomainError('FIELD_LOCKED','This value is protected by an immutable planning baseline.',{details:value.details});
  return value;
}
function never(value:never):never {throw new Error(`Unhandled planning mutation intent: ${String(value)}`);}

/** Mandatory shared pre-handler policy: all command families are exhaustively classified. */
export function createPlanningMutationGuard(scope:PlanningWriteScope,tools:Pick<PlanningTools,'newId'|'digest'>):PlanningMutationGuard {
  return {async check(intent:PlanningMutationIntent) {
    const repo=scope.repository,ws=scope.context.workspaceId;
    const due=(await repo.listPeriods(ws)).filter(p=>p.state==='planning'&&Date.parse(p.cutoffAt)<=scope.barrierAt.getTime());
    const newlyFrozen:string[]=[];
    for(const period of due)newlyFrozen.push((await performFreeze(scope,period,'project',null,'cutoff',tools)).id);
    const locks=await repo.listLocks(ws);
    const input=record(intent.input),target=record(intent.target);
    let blocked:string[]=[];
    switch(intent.family) {
      case 'task':
        switch(intent.command) {
          case 'task.update': {
            const task=intent.target===null?null:await repo.tasks.findTask(ws,intent.target);
            if(task&&input['estimateMinutes']!==undefined)blocked=locks.filter(l=>l.kind==='estimate'&&l.workPackageId===task.workPackageId).map(l=>l.baselineId);
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
          case 'project.create':case 'project.update':case 'section.create':case 'section.update':
          case 'tag.create':case 'tag.update':case 'task.create':case 'task.archive':case 'task.restore':break;
          default:never(intent);
        }
        break;
      case 'field':
        switch(intent.command) {
          case 'field.value.set':blocked=locks.filter(l=>l.kind==='custom_value'&&l.taskId===target['taskId']&&l.fieldId===target['fieldId']).map(l=>l.baselineId);break;
          case 'field.create':case 'field.update':case 'field.option.create':case 'field.option.update':case 'field.columns.update':break;
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
          case 'period.create':case 'commitment.create':case 'plan.freeze':case 'work.set':case 'report.create':break;
          default:never(intent);
        }
        break;
      case 'category':
        switch(intent.command) {
          case 'category.binding.update':case 'work.recategorize':case 'work_type_report.create':break;
          default:never(intent);
        }
        break;
      default:never(intent);
    }
    return blocked.length?{__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[...new Set([...blocked,...newlyFrozen])].sort()}}:null;
  }};
}
