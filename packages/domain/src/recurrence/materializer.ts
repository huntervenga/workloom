import {
 RECURRENCE_LIMITS,RECURRENCE_MATERIALIZATION_REQUESTED,RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,idSchema,
 type FreezeScope,type MeetingDto,type PlanningPeriodDto,type RecurrenceBindingProgressDto,type RecurrenceBlockedCode,type RecurrenceCalendarState,type RecurrenceCensusEntryDto,
 type RecurrenceResolutionDto,type RecurrenceSnapshotSectionDto,type RecurrenceTemplateInput,
} from '@workloom/contracts';
import {roleHasCapability} from '../access/capabilities.js';
import {DomainError,isDomainError} from '../errors.js';
import {meetingLocalDate} from '../meetings/service.js';
import {materializationRequiredError} from '../planning/freeze.js';
import type {PlanningRepository} from '../planning/ports.js';
import {canonicalJson} from '../tasks/service.js';
import {resolveRecurrenceAffectedProjects} from './footprint.js';
import {buildRecurrenceScheduleSegments} from './schedule.js';
import type {
 RecurrenceAffectedFootprint,RecurrenceAuthorityCheck,RecurrenceCensusAssessment,RecurrenceEnsureOptions,RecurrenceEnsureOutcome,
 RecurrenceExceptionVersionRecord,RecurrenceInstanceHeader,RecurrenceMaterializationCursor,RecurrenceOccurrenceComposer,RecurrenceOccurrenceResolver,
 RecurrencePeriodBindingRecord,RecurrenceRepository,RecurrenceScheduleSegment,RecurrenceScopedMaterializer,RecurrenceSeriesRecord,
 RecurrenceSeriesVersionRecord,RecurrenceSourceManifestInput,RecurrenceTools,RecurrenceWriteScope,ValidatedGenerationAuthority,
} from './ports.js';
import {occurrenceMeetingInput} from './composer.js';

/** Internal P3b census core shared by the scoped materializer, the application and the worker.
 *
 * Internal signatures (stable for the DB/worker lanes; additive to the frozen ports):
 * - createRecurrenceScopedMaterializer(scope:RecurrenceWriteScope,tools:RecurrenceTools,composer:RecurrenceOccurrenceComposer):RecurrenceFreezeCensus
 *   (a RecurrenceScopedMaterializer plus insertCalendarLocks). The scope is read lazily at call time, so a composition
 *   may bind `scope.recurrenceCensus` to the returned object after construction (same tx, same recordChange).
 * - evaluatePeriodCensus(repo,tools,period,at,bindingId) — pure read: enumeration/resolution before any insert.
 * - validateGenerationAuthority(repo,series,at) — stored authorizer membership/task.edit/revision under the caller's barrier.
 * - bindingSourceManifestHash / periodManifestHash — generation inputs only, stable across successful chunks.
 * - requestMaterialization(scope,binding,hash,authorizationRevision,reason) — the only subscribed outbox row.
 */
export type RecurrenceFreezeCensus=RecurrenceScopedMaterializer;

export type RecurrenceVersionLike=Pick<RecurrenceSeriesVersionRecord,'id'|'revision'|'effectiveFromNominalDate'|'schedule'|'template'>;
export interface PlannedCandidate {readonly occurrenceKey:string;readonly nominalSequence:number|null;readonly sourceVersionId:string;readonly resolution:RecurrenceResolutionDto}
export interface DesiredOccurrence {readonly calendarState:RecurrenceCalendarState;readonly resolution:RecurrenceResolutionDto;readonly sourceVersionId:string}
export interface RecurrenceSeriesContext {
 readonly series:RecurrenceSeriesRecord;readonly versions:readonly RecurrenceSeriesVersionRecord[];
 readonly bindings:readonly RecurrencePeriodBindingRecord[];readonly periods:ReadonlyMap<string,PlanningPeriodDto>;
 readonly headers:readonly RecurrenceInstanceHeader[];readonly heads:ReadonlyMap<string,RecurrenceExceptionVersionRecord>;
}
export interface HeaderDraft {readonly occurrenceKey:string;readonly nominalSequence:number|null;readonly sourceVersionId:string;readonly resolution:RecurrenceResolutionDto}
export interface BindingCensus {
 readonly reservations:readonly HeaderDraft[];readonly missingHeaders:readonly RecurrenceInstanceHeader[];readonly missingCount:number;
 readonly headerCount:number;readonly materializedCount:number;readonly cancelledHeaderOnlyCount:number;readonly conflict:boolean;
}
export interface EvaluatedBinding {
 readonly binding:RecurrencePeriodBindingRecord;readonly context:RecurrenceSeriesContext|null;readonly hash:string;
 readonly census:BindingCensus|null;readonly missingCount:number;readonly state:'complete'|'pending'|'blocked';
 readonly blockedCode:RecurrenceBlockedCode|null;readonly authority:ValidatedGenerationAuthority|null;
}

export function newEntityId(tools:Pick<RecurrenceTools,'newId'>):string {return idSchema.parse(tools.newId());}
const byKey=(a:{occurrenceKey:string},b:{occurrenceKey:string})=>a.occurrenceKey<b.occurrenceKey?-1:a.occurrenceKey>b.occurrenceKey?1:0;
const byId=(a:{id:string},b:{id:string})=>a.id.localeCompare(b.id);

// ---- Versions, segments and pure candidates ---------------------------------------------------

export function sortVersions<T extends Pick<RecurrenceVersionLike,'revision'|'effectiveFromNominalDate'>>(versions:readonly T[]):T[] {
 return [...versions].sort((a,b)=>a.effectiveFromNominalDate<b.effectiveFromNominalDate?-1:a.effectiveFromNominalDate>b.effectiveFromNominalDate?1:a.revision-b.revision);
}
/** Latest write effective on a nominal date wins, including over an older future segment. */
export function scheduleSegments(versions:readonly RecurrenceVersionLike[]):RecurrenceScheduleSegment[] {
 return buildRecurrenceScheduleSegments(versions);
}
export function versionAt<T extends RecurrenceVersionLike>(versions:readonly T[],key:string):T {
 const version=[...versions].filter(v=>v.effectiveFromNominalDate<=key).sort((a,b)=>b.revision-a.revision)[0];
 if(!version)throw new Error('A recurrence series has no version effective on this date.');return version;
}
/** Full finite enumeration (≤366 per series, no horizon); calendar-date arithmetic lives in the shared resolver. */
export function planCandidates(resolver:RecurrenceOccurrenceResolver,versions:readonly RecurrenceVersionLike[]):PlannedCandidate[] {
 const known=new Map(versions.map(v=>[v.id,v])),list=resolver.enumerateNominalCandidates(scheduleSegments(versions));
 if(list.length>RECURRENCE_LIMITS.maxNominalCandidatesPerSeries)throw new DomainError('DOMAIN_VALIDATION_FAILED','A series can have at most 366 nominal occurrences.');
 const seen=new Set<string>();
 return list.map(c=>{
  const v=known.get(c.sourceVersionId);if(!v)throw new Error('The resolver returned an unknown series version.');
  if(seen.has(c.occurrenceKey))throw new Error('The resolver returned two candidates for one nominal date.');seen.add(c.occurrenceKey);
  return {occurrenceKey:c.occurrenceKey,nominalSequence:c.nominalSequence,sourceVersionId:c.sourceVersionId,resolution:resolver.resolveOccurrence(c.occurrenceKey,v.schedule.localTime,v.schedule.timezone,v.schedule.plannedDurationMinutes)};
 }).sort(byKey);
}
export function resolutionInPeriod(resolution:RecurrenceResolutionDto,period:PlanningPeriodDto):boolean {
 const date=meetingLocalDate(resolution.resolvedStartAt,period.timezone);return date>=period.localStart&&date<period.localEndExclusive;
}
/** Ownership is checked by resolved instant in each period's own timezone. */
export function owningPeriods(resolution:RecurrenceResolutionDto,periods:Iterable<PlanningPeriodDto>):PlanningPeriodDto[] {
 return [...periods].filter(p=>resolutionInPeriod(resolution,p)).sort(byId);
}
export function ambiguousOwnershipError():DomainError {
 return new DomainError('DOMAIN_VALIDATION_FAILED','Selected periods overlap for one occurrence. Choose one period for each date.');
}
export function collisions(candidates:readonly {occurrenceKey:string;resolution:RecurrenceResolutionDto}[],key:string,resolution:RecurrenceResolutionDto):string[] {
 const at=Date.parse(resolution.resolvedStartAt);return candidates.filter(c=>c.occurrenceKey!==key&&Date.parse(c.resolution.resolvedStartAt)===at).map(c=>c.occurrenceKey).sort();
}

/** Current state of one header under the series rule and its manual exception head.
 * regenerate: manual skip/move override wins; a cancelled header is never revived automatically.
 * explicit_reset: the reset command returns the header to its rule-derived state.
 */
export function desiredOccurrence(resolver:RecurrenceOccurrenceResolver,versions:readonly RecurrenceVersionLike[],key:string,header:RecurrenceInstanceHeader|null,candidate:PlannedCandidate|null,head:RecurrenceExceptionVersionRecord|null,mode:'regenerate'|'explicit_reset'='regenerate'):DesiredOccurrence|null {
 const kind=mode==='explicit_reset'?null:head?.kind??null;
 if(header&&kind==='skip')return {calendarState:'cancelled',resolution:header.resolution,sourceVersionId:header.sourceVersionId};
 if(header&&kind==='move'&&head?.localDate&&head.localTime){
  const v=versions.find(x=>x.id===header.sourceVersionId)??versionAt(versions,key);
  return {calendarState:'scheduled',resolution:resolver.resolveOccurrence(head.localDate,head.localTime,v.schedule.timezone,v.schedule.plannedDurationMinutes),sourceVersionId:header.sourceVersionId};
 }
 if(header&&kind==='restore'){
  if(candidate)return {calendarState:'scheduled',resolution:candidate.resolution,sourceVersionId:candidate.sourceVersionId};
  const v=versionAt(versions,key);return {calendarState:'scheduled',resolution:resolver.resolveOccurrence(key,v.schedule.localTime,v.schedule.timezone,v.schedule.plannedDurationMinutes),sourceVersionId:v.id};
 }
 if(!header)return candidate?{calendarState:'scheduled',resolution:candidate.resolution,sourceVersionId:candidate.sourceVersionId}:null;
 if(mode==='regenerate'&&header.calendarState==='cancelled')return {calendarState:'cancelled',resolution:header.resolution,sourceVersionId:header.sourceVersionId};
 return candidate?{calendarState:'scheduled',resolution:candidate.resolution,sourceVersionId:candidate.sourceVersionId}:{calendarState:'cancelled',resolution:header.resolution,sourceVersionId:header.sourceVersionId};
}

// ---- Loading ----------------------------------------------------------------------------------

export async function loadSeriesContext(repo:RecurrenceRepository,workspaceId:string,series:RecurrenceSeriesRecord):Promise<RecurrenceSeriesContext> {
 const [versions,bindings]=await Promise.all([repo.listSeriesVersions(workspaceId,series.id),repo.listBindings(workspaceId,series.id)]);
 const periods=new Map<string,PlanningPeriodDto>();
 for(const b of bindings){const p=await repo.planning.findPeriod(workspaceId,b.periodId);if(!p||p.projectId!==series.projectId)throw new Error('A recurrence binding lost its period.');periods.set(p.id,p);}
 const headers=(await Promise.all(bindings.map(b=>repo.listInstanceHeaders(workspaceId,b.id)))).flat().sort(byKey);
 const heads=new Map<string,RecurrenceExceptionVersionRecord>();
 for(const h of headers)if(h.exceptionVersionId){const head=(await repo.listExceptionVersions(workspaceId,h.id)).find(e=>e.id===h.exceptionVersionId);if(!head)throw new Error('A recurrence exception head is missing.');heads.set(h.id,head);}
 return {series,versions:sortVersions(versions),bindings:[...bindings].sort(byId),periods,headers,heads};
}

// ---- Source manifest --------------------------------------------------------------------------

/** Generation inputs only: never materialized IDs, progress, header attach revisions, timestamps or period revision. */
export function bindingManifestInput(policyVersion:RecurrenceSourceManifestInput['policyVersion'],context:Pick<RecurrenceSeriesContext,'series'|'versions'|'headers'|'heads'>,binding:Pick<RecurrencePeriodBindingRecord,'id'|'periodId'>,period:PlanningPeriodDto,authorization:{readonly authorizationId:string;readonly revision:number}|null):RecurrenceSourceManifestInput {
 const {series}=context;
 return {
  schemaVersion:1,policyVersion,workspaceId:series.workspaceId,projectId:series.projectId,seriesId:series.id,bindingId:binding.id,
  period:{periodId:period.id,localStart:period.localStart,localEndExclusive:period.localEndExclusive,timezone:period.timezone},
  versions:sortVersions(context.versions).map(v=>({versionId:v.id,revision:v.revision,effectiveFromNominalDate:v.effectiveFromNominalDate})),
  exceptions:context.headers.filter(h=>h.bindingId===binding.id&&h.exceptionVersionId!==null).map(h=>{const head=context.heads.get(h.id);if(!head)throw new Error('A recurrence exception head is missing.');return {occurrenceKey:h.occurrenceKey,exceptionVersionId:head.id,revision:head.revision,kind:head.kind};}).sort(byKey),
  authorization,
 };
}
export function seriesAuthorizationRef(series:RecurrenceSeriesRecord):{authorizationId:string;revision:number}|null {
 return series.authorizationId!==null&&series.authorizationRevision!==null?{authorizationId:series.authorizationId,revision:series.authorizationRevision}:null;
}
export function bindingSourceManifestHash(tools:Pick<RecurrenceTools,'digest'|'resolver'>,context:Pick<RecurrenceSeriesContext,'series'|'versions'|'headers'|'heads'>,binding:Pick<RecurrencePeriodBindingRecord,'id'|'periodId'>,period:PlanningPeriodDto):string {
 return tools.digest(canonicalJson(bindingManifestInput(tools.resolver.policyVersion,context,binding,period,seriesAuthorizationRef(context.series))));
}
export function periodManifestHash(tools:Pick<RecurrenceTools,'digest'>,periodId:string,bindings:readonly {readonly bindingId:string;readonly hash:string}[]):string {
 return tools.digest(canonicalJson({schemaVersion:1,periodId,bindings:[...bindings].map(b=>({bindingId:b.bindingId,hash:b.hash})).sort((a,b)=>a.bindingId.localeCompare(b.bindingId))}));
}

// ---- Authority and template -------------------------------------------------------------------

/** Revalidates the persisted authorizer (membership, task.edit, revision) under the caller's barrier.
 * It never substitutes the triggering ctx actor and never falls back to an owner or organizer.
 */
export async function validateGenerationAuthority(repo:RecurrenceRepository,series:RecurrenceSeriesRecord,at:Date):Promise<RecurrenceAuthorityCheck> {
 const blocked=(code:RecurrenceBlockedCode):RecurrenceAuthorityCheck=>({kind:'blocked',code});
 if(series.authorizationId===null||series.authorizationRevision===null)return blocked('authorization_missing');
 const grant=await repo.findAuthorization(series.workspaceId,series.authorizationId);
 if(!grant||grant.seriesId!==series.id)return blocked('authorization_missing');
 if(grant.revision!==series.authorizationRevision)return blocked('authorization_revision_stale');
 const access=await repo.planning.tasks.access.findWorkspaceAccess(series.workspaceId,grant.authorizerUserId);
 if(!access||access.membership.id!==grant.authorizerMembershipId||access.membership.state!=='active')return blocked('authorizer_inactive');
 if(!roleHasCapability(access.membership.role,'task.edit'))return blocked('authorizer_capability_revoked');
 return {kind:'valid',authority:{__workloomGenerationAuthority:'validated',seriesId:series.id,authorizationId:grant.id,authorizationRevision:grant.revision,authorizerUserId:grant.authorizerUserId,authorizerMembershipId:grant.authorizerMembershipId,validatedAt:at}};
}
export type TemplateProblem='not_found'|'rule'|null;
export async function templateProblem(repo:PlanningRepository,workspaceId:string,projectId:string,template:RecurrenceTemplateInput):Promise<TemplateProblem> {
 const project=await repo.tasks.findProject(workspaceId,projectId);if(!project)return 'not_found';if(project.archivedAt)return 'rule';
 const status=await repo.tasks.findStatus(workspaceId,template.statusId);if(!status)return 'not_found';if(status.projectId!==projectId)return 'rule';
 if(template.sectionId){const section=await repo.tasks.findSection(workspaceId,template.sectionId);if(!section)return 'not_found';if(section.projectId!==projectId||section.archivedAt)return 'rule';}
 const active=(await repo.captureProject(workspaceId,projectId)).activeMembershipIds;
 return [...template.attendeeMembershipIds,template.organizerMembershipId].every(id=>active.includes(id))?null:'not_found';
}

// ---- Census evaluation ------------------------------------------------------------------------

/** Pure ownership/census plan of one binding: reserved-but-unmaterialized and not-yet-reserved candidates.
 * A cancelled header without a real composition is header-only census, never missing.
 */
export function planBindingCensus(context:RecurrenceSeriesContext,binding:RecurrencePeriodBindingRecord,candidates:readonly PlannedCandidate[]):BindingCensus {
 const period=context.periods.get(binding.periodId);if(!period)throw new Error('A recurrence binding lost its period.');
 const headersByKey=new Map(context.headers.map(h=>[h.occurrenceKey,h])),bound=[...context.periods.values()];
 const reservations:HeaderDraft[]=[];let conflict=false;
 for(const c of candidates){
  if(headersByKey.has(c.occurrenceKey))continue;
  const owners=owningPeriods(c.resolution,bound);
  if(owners.length>1&&owners.some(p=>p.id===period.id))conflict=true;
  else if(owners.length===1&&owners[0]?.id===period.id)reservations.push({occurrenceKey:c.occurrenceKey,nominalSequence:c.nominalSequence,sourceVersionId:c.sourceVersionId,resolution:c.resolution});
 }
 const own=context.headers.filter(h=>h.bindingId===binding.id);
 for(const h of own)if(h.calendarState==='scheduled'&&!resolutionInPeriod(h.resolution,period))conflict=true;
 const missingHeaders=own.filter(h=>h.calendarState==='scheduled'&&h.locator===null).sort(byKey);
 return {reservations,missingHeaders,missingCount:missingHeaders.length+reservations.length,headerCount:own.length,materializedCount:own.filter(h=>h.locator!==null).length,cancelledHeaderOnlyCount:own.filter(h=>h.calendarState==='cancelled'&&h.locator===null).length,conflict};
}
/** Read-only: every registered binding of the period, active and paused, before any proposed insert. */
export async function evaluatePeriodCensus(repo:RecurrenceRepository,tools:Pick<RecurrenceTools,'digest'|'resolver'>,period:PlanningPeriodDto,at:Date,bindingId:string|null=null):Promise<EvaluatedBinding[]> {
 const ws=period.workspaceId,bindings=(await repo.listBindingsForPeriod(ws,period.id)).filter(b=>bindingId===null||b.id===bindingId);
 const out:EvaluatedBinding[]=[];
 for(const binding of bindings.sort((a,b)=>a.seriesId.localeCompare(b.seriesId)||a.id.localeCompare(b.id))){
  const series=await repo.findSeries(ws,binding.seriesId);
  const fallback=async(code:RecurrenceBlockedCode,context:RecurrenceSeriesContext|null):Promise<EvaluatedBinding>=>{
   const missing=(context?.headers.filter(h=>h.bindingId===binding.id)??await repo.listInstanceHeaders(ws,binding.id)).filter(h=>h.calendarState==='scheduled'&&h.locator===null).length;
   return {binding,context,hash:binding.sourceManifestHash,census:null,missingCount:missing,state:'blocked',blockedCode:code,authority:null};
  };
  if(!series){out.push(await fallback('source_unavailable',null));continue;}
  const context=await loadSeriesContext(repo,ws,series),hash=bindingSourceManifestHash(tools,context,binding,period);
  let candidates:PlannedCandidate[];
  // Stored inputs were validated on write; a resolver rejection here is a bounded readiness block, not a write.
  try{candidates=planCandidates(tools.resolver,context.versions);}catch(error){if(!isDomainError(error))throw error;out.push({...await fallback('candidate_limit_exceeded',context),hash});continue;}
  const census=planBindingCensus(context,binding,candidates),base={binding,context,hash,census,missingCount:census.missingCount};
  if(census.conflict){out.push({...base,state:'blocked',blockedCode:'cross_period_conflict',authority:null});continue;}
  if(census.missingCount===0){out.push({...base,state:'complete',blockedCode:null,authority:null});continue;}
  const check=await validateGenerationAuthority(repo,series,at);
  if(check.kind==='blocked'){out.push({...base,state:'blocked',blockedCode:check.code,authority:null});continue;}
  const versionIds=new Set([...census.missingHeaders.map(h=>h.sourceVersionId),...census.reservations.map(r=>r.sourceVersionId)]);
  let usable=true;
  for(const v of context.versions)if(versionIds.has(v.id)&&await templateProblem(repo.planning,ws,series.projectId,v.template)!==null)usable=false;
  out.push(usable?{...base,state:'pending',blockedCode:null,authority:check.authority}:{...base,state:'blocked',blockedCode:'source_unavailable',authority:null});
 }
 return out;
}
export function progressOf(e:EvaluatedBinding,createdCount=0):RecurrenceBindingProgressDto {
 const remainingCount=Math.max(0,e.missingCount-createdCount);
 return {bindingId:e.binding.id,seriesId:e.binding.seriesId,sourceManifestHash:e.hash,state:e.state==='blocked'?'blocked':remainingCount>0?'pending':'complete',createdCount,remainingCount,blockedCode:e.state==='blocked'?e.blockedCode:null};
}
export function assessmentOf(periodId:string,evaluated:readonly EvaluatedBinding[]):RecurrenceCensusAssessment {
 const bindings=evaluated.map(e=>progressOf(e));
 return {periodId,status:bindings.some(b=>b.state==='blocked')?'blocked':bindings.some(b=>b.remainingCount>0)?'pending':'complete',missingCount:bindings.reduce((a,b)=>a+b.remainingCount,0),bindings};
}
export function headerFromDraft(tools:Pick<RecurrenceTools,'newId'>,binding:RecurrencePeriodBindingRecord,draft:HeaderDraft,now:string):RecurrenceInstanceHeader {
 return {id:newEntityId(tools),workspaceId:binding.workspaceId,projectId:binding.projectId,seriesId:binding.seriesId,bindingId:binding.id,periodId:binding.periodId,occurrenceKey:draft.occurrenceKey,nominalSequence:draft.nominalSequence,sourceVersionId:draft.sourceVersionId,revision:1,calendarState:'scheduled',resolution:draft.resolution,exceptionVersionId:null,locator:null,createdAt:now,updatedAt:now};
}

// ---- Outbox continuation ----------------------------------------------------------------------

export type RecurrenceRequestReason='series_created'|'series_edited'|'periods_added'|'generation_authorized'|'series_resumed'|'continuation'|'stale_job';
/** Exactly one subscribed v1 row per affected binding; the worker never trusts an actor from it. */
export async function requestMaterialization(scope:Pick<RecurrenceWriteScope,'recordChange'>,binding:Pick<RecurrencePeriodBindingRecord,'id'|'seriesId'|'periodId'|'revision'>,sourceManifestHash:string,authorizationRevision:number|null,reason:RecurrenceRequestReason):Promise<void> {
 if(authorizationRevision===null)return; // No grant: nothing a worker may do; readiness stays blocked.
 await scope.recordChange({entityType:'recurrence_binding',entityId:binding.id,action:'materialization_requested',entityRevision:binding.revision,diff:{seriesId:binding.seriesId,periodId:binding.periodId,reason},
  outbox:{type:RECURRENCE_MATERIALIZATION_REQUESTED,schemaVersion:RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,payload:{seriesId:binding.seriesId,bindingId:binding.id,sourceManifestHash,authorizationRevision}}});
}

// ---- Snapshot section -------------------------------------------------------------------------

export async function snapshotSectionOf(repo:RecurrenceRepository,policyVersion:RecurrenceSnapshotSectionDto['policyVersion'],evaluated:readonly EvaluatedBinding[],kind:FreezeScope,memberId:string|null):Promise<RecurrenceSnapshotSectionDto|undefined> {
 if(!evaluated.length)return undefined;
 const bindings:RecurrenceSnapshotSectionDto['bindings']=[],census:RecurrenceCensusEntryDto[]=[];
 for(const e of evaluated){
  const context=e.context;if(!context)throw new Error('A frozen recurrence binding needs its series sources.');
  const included:{header:RecurrenceInstanceHeader;meeting:MeetingDto|null}[]=[];
  for(const h of context.headers.filter(h=>h.bindingId===e.binding.id)){
   const meeting=h.locator?await repo.planning.findMeetingByTask(h.workspaceId,h.locator.taskId):null;
   if(h.locator&&!meeting)throw new Error('A materialized recurrence locator lost its meeting.');
   if(kind==='self'){
    const roster=meeting?(await repo.planning.listAttendance(h.workspaceId,meeting.id)).filter(a=>a.rosterActive).map(a=>a.membershipId):context.versions.find(v=>v.id===h.sourceVersionId)?.template.attendeeMembershipIds??[];
    if(memberId===null||!roster.includes(memberId))continue;
   }
   included.push({header:h,meeting});
  }
  if(kind==='self'&&included.length===0)continue;
  bindings.push({bindingId:e.binding.id,seriesId:context.series.id,bindingRevision:e.binding.revision,seriesState:context.series.state,seriesVersionIds:context.versions.map(v=>v.id).sort(),sourceManifestHash:e.hash});
  for(const {header:h,meeting} of included){
   census.push({instanceId:h.id,seriesId:h.seriesId,bindingId:h.bindingId,occurrenceKey:h.occurrenceKey,nominalSequence:h.nominalSequence,sourceVersionId:h.sourceVersionId,exceptionVersionId:h.exceptionVersionId,calendarState:h.calendarState,resolution:h.resolution,
    meetingId:h.locator?.meetingId??null,taskId:h.locator?.taskId??null,workPackageId:h.locator?.workPackageId??null,meetingRevision:meeting?.revision??null,participantsRevision:meeting?.participantsRevision??null});
  }
 }
 if(bindings.length===0)return undefined;
 return {schemaVersion:1,policyVersion,bindings:bindings.sort((a,b)=>a.seriesId.localeCompare(b.seriesId)||a.bindingId.localeCompare(b.bindingId)),census:census.sort((a,b)=>a.seriesId.localeCompare(b.seriesId)||byKey(a,b))};
}

// ---- Mandatory same-TX materializer -----------------------------------------------------------

function isDue(period:PlanningPeriodDto,at:Date):boolean {return period.state==='planning'&&Date.parse(period.cutoffAt)<=at.getTime();}
export function staleCursorError():DomainError {return new DomainError('PREVIEW_STALE','Recurring meeting sources changed. Restart preparation from the first chunk.');}

export function createRecurrenceScopedMaterializer(scope:RecurrenceWriteScope,tools:RecurrenceTools,composer:RecurrenceOccurrenceComposer):RecurrenceFreezeCensus {
 const evaluate=(period:PlanningPeriodDto,bindingId:string|null=null)=>evaluatePeriodCensus(scope.recurrence,tools,period,scope.barrierAt,bindingId);
 // Census entries carry no project; calendar locks take it from the captured bindings of the same period.
 const census:RecurrenceFreezeCensus={
  resolveAffectedProjects:intent=>resolveRecurrenceAffectedProjects(scope,intent),
  async assessPeriod(period){return assessmentOf(period.id,await evaluate(period));},
  async ensurePeriod(period,options:RecurrenceEnsureOptions):Promise<RecurrenceEnsureOutcome> {
   if(!Number.isInteger(options.maxCreates)||options.maxCreates<1||options.maxCreates>RECURRENCE_LIMITS.maxRealCreatesPerChunk)throw new Error('maxCreates must be 1..100 real compositions.');
   const ws=scope.context.workspaceId;if(period.workspaceId!==ws)throw new Error('The period belongs to another workspace.');
   const evaluated=await evaluate(period,options.bindingId);
   const manifestHash=periodManifestHash(tools,period.id,evaluated.map(e=>({bindingId:e.binding.id,hash:e.hash})));
   const epoch=await scope.repository.tasks.permissionEpoch(ws);
   // The signed cursor only proves continuity; already-created headers carry locators, so work restarts from the first missing key.
   if(options.cursor){const c=options.cursor;if(c.version!==1||c.workspaceId!==ws||c.periodId!==period.id||c.manifestHash!==manifestHash||c.actorUserId!==scope.context.actor.userId||c.permissionEpoch!==epoch)throw staleCursorError();}
   const now=scope.barrierAt.toISOString();let budget=options.maxCreates,last:{seriesId:string;occurrenceKey:string}|null=null;
   const progress:RecurrenceBindingProgressDto[]=[];
   for(const e of evaluated){
    if(e.state!=='pending'||!e.census||!e.context||!e.authority){progress.push(progressOf(e));continue;}
    if(e.census.reservations.length)await scope.recurrence.reserveInstanceHeaders(e.census.reservations.map(d=>headerFromDraft(tools,e.binding,d,now)));
    const missing=(await scope.recurrence.listInstanceHeaders(ws,e.binding.id)).filter(h=>h.calendarState==='scheduled'&&h.locator===null).sort(byKey);
    let created=0;
    for(const header of missing){
     if(budget===0)break;
     const version=e.context.versions.find(v=>v.id===header.sourceVersionId);if(!version)throw new Error('A reserved header lost its series version.');
     await composer.createOccurrenceInScope(scope,header,e.authority,occurrenceMeetingInput(header,version));
     created++;budget--;last={seriesId:header.seriesId,occurrenceKey:header.occurrenceKey};
    }
    progress.push({...progressOf(e,created),remainingCount:missing.length-created,state:missing.length-created>0?'pending':'complete'});
   }
   const createdCount=progress.reduce((a,b)=>a+b.createdCount,0),remainingCount=progress.reduce((a,b)=>a+b.remainingCount,0);
   const status=progress.some(b=>b.state==='blocked')?'blocked':remainingCount>0?'pending':'complete';
   const resumable=progress.some(b=>b.state==='pending');
   const nextCursor:RecurrenceMaterializationCursor|null=resumable?{version:1,workspaceId:ws,actorUserId:scope.context.actor.userId,permissionEpoch:epoch,periodId:period.id,manifestHash,afterSeriesId:last?.seriesId??null,afterOccurrenceKey:last?.occurrenceKey??null}:null;
   return {periodId:period.id,status,missingCount:evaluated.reduce((a,e)=>a+e.missingCount,0),bindings:progress,createdCount,remainingCount,nextCursor};
  },
  async requireCompleteCensus(footprint:RecurrenceAffectedFootprint) {
   if(footprint.kind==='none')return;
   const ws=scope.context.workspaceId;
   for(const projectId of [...new Set(footprint.projectIds)].sort())for(const period of (await scope.repository.listPeriods(ws,projectId)).filter(p=>isDue(p,scope.barrierAt)).sort(byId)){
    const assessment=assessmentOf(period.id,await evaluate(period));if(assessment.status!=='complete')throw materializationRequiredError(period.id,assessment);
   }
  },
  async captureSnapshotSection(period,kind,memberId) {
   const evaluated=await evaluate(period),assessment=assessmentOf(period.id,evaluated);
   if(assessment.status!=='complete')throw materializationRequiredError(period.id,assessment);
   return snapshotSectionOf(scope.recurrence,tools.resolver.policyVersion,evaluated,kind,memberId);
  },
  calendarLocksFor(section,baselineId,projectId) {
   const ws=scope.context.workspaceId;
   return section.census.map(e=>{
    return {id:newEntityId(tools),workspaceId:ws,projectId,baselineId,kind:'recurrence_calendar' as const,instanceId:e.instanceId,meetingId:e.meetingId};
   });
  },
  async insertCalendarLocks(rows){if(rows.length)await scope.recurrence.insertCalendarLocks(rows);},
 };
 return census;
}
