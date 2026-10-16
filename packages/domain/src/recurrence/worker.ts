import {RECURRENCE_LIMITS,idSchema,recurrenceBlockedCodeSchema,recurrenceMaterializationJobSchema} from '@workloom/contracts';
import {DomainError,notFoundError} from '../errors.js';
import {performFreeze} from '../planning/freeze.js';
import {canonicalJson} from '../tasks/service.js';
import {evaluatePeriodCensus,requestMaterialization,validateGenerationAuthority} from './materializer.js';
import type {RecurrenceJobWriteScope,RecurrenceWorkerDependencies,RecurrenceWorkerFacade,RecurrenceWorkerOutcome} from './ports.js';

/** Background materialization of ONE binding per job (docs16 §9).
 * Internal signature: createRecurrenceWorkerFacade(deps:RecurrenceWorkerDependencies):RecurrenceWorkerFacade.
 * - The job payload carries no actor; the stored authorizer is revalidated under the single workspace barrier
 *   (scope.authorization from the job UOW AND the domain validator must both be valid). Trigger provenance stays the job ctx.
 * - paused → controlled outcome, no write, no hot retry. stale → durably requests current inputs inside this job outcome.
 * - pending → continuation request with the same stable hash in the SAME UOW; complete → if the period is overdue and its
 *   whole census is complete, freeze only that period. No due-freeze loop over other periods, no nested runner.
 * Unexpected errors propagate (whole UOW rolls back); nothing is caught to commit partial writes.
 */
function storedOutcome(value:unknown,bindingId:string,periodId:string):RecurrenceWorkerOutcome {
 if(value===null||typeof value!=='object')throw new Error('Invalid stored recurrence job outcome.');
 const row=value as Record<string,unknown>;
 const status=(['complete','pending','stale','blocked','paused'] as const).find(s=>s===row['status']);
 const created=row['createdCount'],remaining=row['remainingCount'],blocked=recurrenceBlockedCodeSchema.nullable().safeParse(row['blockedCode']);
 if(!status||row['bindingId']!==bindingId||row['periodId']!==periodId||!idSchema.safeParse(row['bindingId']).success||!idSchema.safeParse(row['periodId']).success||typeof created!=='number'||!Number.isSafeInteger(created)||created<0||typeof remaining!=='number'||!Number.isSafeInteger(remaining)||remaining<0||!blocked.success)throw new Error('Invalid stored recurrence job outcome.');
 return {status,bindingId,periodId,createdCount:created,remainingCount:remaining,blockedCode:blocked.data};
}

export function createRecurrenceWorkerFacade(deps:RecurrenceWorkerDependencies):RecurrenceWorkerFacade {
 const {writer,tools}=deps;
 return {async materializeBinding(input) {
  const parsed=recurrenceMaterializationJobSchema.safeParse(input);
  if(!parsed.success)throw new DomainError('VALIDATION_FAILED','Invalid recurrence materialization job.');
  const job=parsed.data;
  return writer.run(job,async(scope:RecurrenceJobWriteScope):Promise<RecurrenceWorkerOutcome>=>{
   const ws=job.workspaceId,repo=scope.recurrence;
   if(scope.context.workspaceId!==ws||scope.context.source!=='job')throw new Error('A recurrence job must run in its own workspace job context.');
   const binding=await repo.findBinding(ws,job.bindingId);
   if(!binding||binding.seriesId!==job.seriesId)throw notFoundError();
   const result=(status:RecurrenceWorkerOutcome['status'],extra:Partial<RecurrenceWorkerOutcome>={}):RecurrenceWorkerOutcome=>({status,bindingId:binding.id,periodId:binding.periodId,createdCount:0,remainingCount:0,blockedCode:null,...extra});
   const series=await repo.findSeries(ws,binding.seriesId),period=await repo.planning.findPeriod(ws,binding.periodId);
   if(!series||!period)return result('blocked',{blockedCode:'source_unavailable'});
   // Validate current persisted authority before looking up a durable delivery receipt, even across reauthorization.
   const check=await validateGenerationAuthority(repo,series,scope.barrierAt);
   if(scope.authorization.kind==='blocked')return result('blocked',{blockedCode:scope.authorization.code});
   if(check.kind==='blocked')return result('blocked',{blockedCode:check.code});
   if(scope.authorization.authority.authorizationId!==check.authority.authorizationId||scope.authorization.authority.authorizationRevision!==check.authority.authorizationRevision)
    return result('blocked',{blockedCode:'authorization_revision_stale'});
   const requestKey=tools.digest(job.requestId),payloadHash=tools.digest(canonicalJson({seriesId:job.seriesId,bindingId:job.bindingId,sourceManifestHash:job.sourceManifestHash,authorizationRevision:job.authorizationRevision}));
   const receipt=await repo.findJobReceipt(ws,requestKey);
   if(receipt){if(receipt.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','The recurrence job request was reused with different inputs.');return storedOutcome(receipt.result,binding.id,period.id);}
   const execute=async():Promise<RecurrenceWorkerOutcome>=>{
   if(series.state==='paused')return result('paused');
   const [evaluated]=await evaluatePeriodCensus(repo,tools,period,scope.barrierAt,binding.id);
   if(!evaluated)throw notFoundError();
   if(job.sourceManifestHash!==evaluated.hash||job.authorizationRevision!==series.authorizationRevision){
    // Stale inputs: ask for the current ones durably in this same UOW (no post-commit gap) when work remains.
    if(evaluated.missingCount>0)await requestMaterialization(scope,binding,evaluated.hash,series.authorizationRevision,'stale_job');
    return result('stale',{remainingCount:evaluated.missingCount});
   }
   if(evaluated.state==='blocked')return result('blocked',{blockedCode:evaluated.blockedCode,remainingCount:evaluated.missingCount});
   const outcome=await scope.recurrenceCensus.ensurePeriod(period,{maxCreates:RECURRENCE_LIMITS.maxRealCreatesPerChunk,reason:'worker',cursor:null,bindingId:binding.id});
   const progress=outcome.bindings.find(b=>b.bindingId===binding.id);
   if(!progress)throw new Error('The materializer lost the job binding.');
   if(progress.state==='blocked')return result('blocked',{blockedCode:progress.blockedCode,createdCount:progress.createdCount,remainingCount:progress.remainingCount});
   if(progress.remainingCount>0){
    await requestMaterialization(scope,binding,progress.sourceManifestHash,series.authorizationRevision,'continuation');
    return result('pending',{createdCount:progress.createdCount,remainingCount:progress.remainingCount});
   }
   if(period.state==='planning'&&Date.parse(period.cutoffAt)<=scope.barrierAt.getTime()&&(await scope.recurrenceCensus.assessPeriod(period)).status==='complete')
    await performFreeze(scope,period,'project',null,'cutoff',tools);
   return result('complete',{createdCount:progress.createdCount});
   };
   const outcome=await execute();
   await repo.insertJobReceipt(ws,scope.context.actor.userId,requestKey,payloadHash,outcome,scope.barrierAt.toISOString());
   return outcome;
  });
 }};
}
