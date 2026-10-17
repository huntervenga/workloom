import {
  createTaskRowInputSchema,idSchema,taskRowCreatedSchema,
  type CreateTaskRowInput,type ManualPeriodWorkLogDto,type PeriodCommitmentDto,type TaskFieldValueDto,type TaskRowCreatedDto,
} from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import { DomainError,notFoundError,unauthenticatedError } from '../errors.js';
import { setTaskFieldValueInScope } from '../fields/service.js';
import { createPlanningMutationGuard,isCommittedPlanningRejection,unwrapPlanningOutcome } from '../planning/freeze.js';
import type { CommittedPlanningRejection,PlanningApplicationWriteScope,PlanningMutationGuard } from '../planning/ports.js';
import { authorizePlanningMemberInScope,createCommitmentInScope,setManualPeriodWorkInScope,updateCommitmentInScope } from '../planning/service.js';
import { canonicalJson,createTaskInScope } from '../tasks/service.js';
import type { TaskRowApplication,TaskRowApplicationDependencies } from './ports.js';

const COMMAND='task.row.create';
interface Parser<T> {safeParse(value:unknown):{success:true;data:T}|{success:false;error:{issues:readonly {path:readonly PropertyKey[]}[]}}}
function parse<T>(schema:Parser<T>,value:unknown):T {const p=schema.safeParse(value);if(p.success)return p.data;throw new DomainError('VALIDATION_FAILED','The input is invalid.',{details:{fields:p.error.issues.map(i=>i.path.join('.'))}});}
function found<T>(v:T|null):T {if(v===null)throw notFoundError();return v;}
function rule(message:string,field:string):DomainError {return new DomainError('DOMAIN_VALIDATION_FAILED',message,{details:{fields:[field]}});}
function conflict(message:string,field:string):DomainError {return new DomainError('REVISION_CONFLICT',message,{details:{fields:[field]}});}
function sameId(left:string,right:string):boolean {return left.toLowerCase()===right.toLowerCase();}
function normalize(ctx:CommandContext):CommandContext {if(!ctx.actor||!idSchema.safeParse(ctx.actor.userId).success)throw unauthenticatedError();return {...ctx,workspaceId:parse(idSchema,ctx.workspaceId),actor:{...ctx.actor,userId:parse(idSchema,ctx.actor.userId)}};}

/** How the explicit plan lands on the created task's whole work package, decided before any write. */
type PlanBranch =
  | {readonly kind:'create'}
  | {readonly kind:'update';readonly existing:PeriodCommitmentDto};

/**
 * Atomic table-row creation. Order under one workspace barrier:
 * current project + plan/time target authorization → `task.row.create` receipt replay → read-only preflight →
 * mandatory guards (row, then an existing shared-package commitment) → task → every custom value → plan → actual → receipt.
 * A tagged guard rejection commits only its freezes and the receipt; any other failure rolls everything back.
 */
export function createTaskRowApplication({writer,tools}:TaskRowApplicationDependencies):TaskRowApplication {
  const digest=(v:unknown)=>tools.digest(canonicalJson(v));
  return {
    async createRow(context,input) {
      const ctx=normalize(context),key=ctx.idempotencyKey;
      if(key===undefined||!/^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');
      const p:CreateTaskRowInput=parse(createTaskRowInputSchema,input),target={projectId:p.task.projectId};
      const payloadHash=digest({command:COMMAND,target,input:p});
      const outcome=await writer.run(ctx,'task.edit',async (scope):Promise<TaskRowCreatedDto|CommittedPlanningRejection>=>{
        const ws=ctx.workspaceId,actorUserId=ctx.actor.userId,tasks=scope.repository.tasks;
        // Current authorization precedes replay: a revoked plan/time capability cannot replay an old row.
        const project=found(await tasks.findProject(ws,p.task.projectId));
        if(p.plan)await authorizePlanningMemberInScope(scope,p.plan.membershipId,'plan');
        if(p.actual)await authorizePlanningMemberInScope(scope,p.actual.membershipId,'time');
        const old=await tasks.findIdempotency(ws,actorUserId,COMMAND,key);
        if(old) {
          if(old.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This Idempotency-Key was used for another request.');
          if(isCommittedPlanningRejection(old.result))return old.result;
          const stored=taskRowCreatedSchema.safeParse(old.result);
          if(!stored.success)throw new Error('Stored idempotent result does not match its contract.');
          return stored.data;
        }
        const branch=await preflight(scope,project.id,p);
        const now=scope.barrierAt.toISOString(),guard=createPlanningMutationGuard(scope,tools);
        let result:TaskRowCreatedDto|CommittedPlanningRejection|null=await guard.check({family:'task_row',command:COMMAND,target,input:p});
        if(result===null&&p.plan&&branch?.kind==='update') {
          // Changing an existing shared-package plan is the same protected edit as commitment.update.
          result=await guard.check({family:'planning',command:'commitment.update',target:{periodId:p.plan.periodId,commitmentId:branch.existing.id},input:updateOf(branch.existing,p.plan.plannedMinutes)});
        }
        result??=await createAll(scope,p,branch,guard);
        await tasks.insertIdempotency({workspaceId:ws,actorUserId,command:COMMAND,idempotencyKey:key,payloadHash,result,createdAt:now});
        return result;
      });
      return unwrapPlanningOutcome(outcome);
    },
  };

  async function createAll(scope:PlanningApplicationWriteScope,p:CreateTaskRowInput,branch:PlanBranch|null,planningGuard:PlanningMutationGuard):Promise<TaskRowCreatedDto> {
    const task=await createTaskInScope({...scope,repository:scope.repository.tasks,planningGuard},p.task,tools);
    // Every custom value first: the category resolver captures custom work-category sources for the actual.
    const fields:TaskFieldValueDto[]=[];
    for(const f of p.fields??[])fields.push(await setTaskFieldValueInScope({...scope,repository:scope.repository.fields,planningGuard},task.id,f.fieldId,{expectedRevision:0,expectedDefinitionRevision:f.expectedDefinitionRevision,value:f.value},tools));
    let plan:PeriodCommitmentDto|undefined;
    if(p.plan) {
      if(branch?.kind==='update') {
        if(!sameId(task.workPackageId,branch.existing.workPackageId))throw new Error('A detail subtask must share its parent work package.');
        plan=await updateCommitmentInScope(scope,p.plan.periodId,branch.existing.id,updateOf(branch.existing,p.plan.plannedMinutes),tools);
      } else {
        plan=await createCommitmentInScope(scope,p.plan.periodId,{workPackageId:task.workPackageId,membershipId:p.plan.membershipId,expectedAbsent:true,plannedMinutes:p.plan.plannedMinutes,allocations:[]},tools);
      }
    }
    let actual:ManualPeriodWorkLogDto|undefined;
    if(p.actual)actual=await setManualPeriodWorkInScope(scope,task.id,p.actual.periodId,p.actual.membershipId,{expectedRevision:null,minutes:p.actual.minutes,state:'active',reason:p.actual.reason??null},tools);
    return {task,fields,...(plan===undefined?{}:{plan}),...(actual===undefined?{}:{actual})};
  }
}

/** The existing whole-package commitment keeps its allocations and stays active; only the plan total changes. */
function updateOf(existing:PeriodCommitmentDto,plannedMinutes:number|null) {
  return {expectedRevision:existing.revision,plannedMinutes,allocations:existing.allocations.map(a=>({taskId:a.taskId,minutes:a.minutes})),state:'active' as const};
}

/**
 * Read-only checks of everything the row references, so a stale or foreign reference rejects before any freeze
 * or proposed write. The primitives re-check under the same barrier; this never replaces them.
 */
async function preflight(scope:PlanningApplicationWriteScope,projectId:string,p:CreateTaskRowInput):Promise<PlanBranch|null> {
  const repo=scope.repository,ws=scope.context.workspaceId;
  const parentId=p.task.parentTaskId??null,parent=parentId===null?null:found(await repo.tasks.findTask(ws,parentId));
  if(parent&&!sameId(parent.projectId,projectId))throw rule('The referenced object belongs to another project.','task.parentTaskId');
  for(const [index,f] of (p.fields??[]).entries()) {
    const field=found(await repo.fields.findField(ws,f.fieldId)),at=`fields.${index}`;
    if(!sameId(field.projectId,projectId))throw rule('The field belongs to another project.',`${at}.fieldId`);
    // The aggregate guard classifies a manual lock after due freezes, before any proposal.
    // Defer the remaining checks too: field.value.set gives the manual lock precedence.
    if(field.locked)continue;
    if(field.revision!==f.expectedDefinitionRevision)throw conflict('The field definition changed. Reload and retry.',`${at}.expectedDefinitionRevision`);
    if(field.archivedAt!==null)throw rule('The field is archived.',`${at}.fieldId`);
    if(field.type!==f.value.type)throw rule('The value type does not match the field type.',`${at}.value.type`);
  }
  for(const [name,periodId] of [['plan',p.plan?.periodId],['actual',p.actual?.periodId]] as const) {
    if(periodId===undefined)continue;
    const period=found(await repo.findPeriod(ws,periodId));
    if(!sameId(period.projectId,projectId))throw rule('The period belongs to another project.',`${name}.periodId`);
  }
  const plan=p.plan;
  if(!plan)return null;
  // Root and added-scope rows get a brand-new package, so no commitment can exist yet.
  if(parent===null||p.task.workScope==='added_scope') {
    if(plan.expectedRevision!==null)throw rule('A new work package has no personal commitment; expectedRevision must be null.','plan.expectedRevision');
    return {kind:'create'};
  }
  // A detail subtask plans its parent's whole package: never duplicate, override or silently restore that commitment.
  const existing=(await repo.listCommitments(ws,plan.periodId)).find(c=>sameId(c.workPackageId,parent.workPackageId)&&sameId(c.membershipId,plan.membershipId))??null;
  if(existing===null) {
    if(plan.expectedRevision!==null)throw conflict('This personal commitment does not exist.','plan.expectedRevision');
    return {kind:'create'};
  }
  if(existing.state==='removed')throw rule('The personal commitment of this package was removed. Restore it explicitly before planning.','plan');
  if(plan.expectedRevision===null)throw conflict('This personal commitment already exists.','plan.expectedRevision');
  if(existing.revision!==plan.expectedRevision)throw conflict('The personal commitment changed. Reload and retry.','plan.expectedRevision');
  return {kind:'update',existing};
}
