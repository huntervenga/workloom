import {and,asc,eq,inArray,isNull,type AnyColumn,type SQL} from 'drizzle-orm';
import {
 idSchema,recurrenceCalendarDateSchema,recurrenceHashSchema,recurrenceResolutionSchema,recurrenceSeriesVersionSchema,
 type RecurrenceResolutionDto,
} from '@workloom/contracts';
import {
 DomainError,notFoundError,
 type CommandSource,type PlanningRepository,type RecurrenceCalendarLock,type RecurrenceEntityLocator,type RecurrenceExceptionVersionRecord,
 type RecurrenceGenerationAuthorizationRecord,type RecurrenceInstanceHeader,type RecurrencePeriodBindingRecord,type RecurrenceRepository,
 type RecurrenceSeriesRecord,type RecurrenceSeriesVersionRecord,
} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {
 commandIdempotency,recurrenceCalendarLocks,recurrenceExceptionVersions,recurrenceGenerationAuthorizations,recurrenceInstances,recurrencePeriodBindings,
 recurrenceSeries,recurrenceSeriesVersions,
} from '../schema.js';
import {createPlanningRepository} from './planning-repository.js';

export interface RecurrenceRepositoryOptions {
 /** Share the planning repository of the same TX instead of creating another one. */
 readonly planning?:PlanningRepository;
 /** Repeatable-read previews/reads: every mutation throws before touching the database. */
 readonly readOnly?:boolean;
 /** Trusted command source of the open write scope (stored on immutable series versions). */
 readonly source?:CommandSource;
 /** Server barrier clock of the open write scope (header attach timestamp). */
 readonly changedAt?:Date;
}

const iso=(v:Date):string=>v.toISOString();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid=(v:string):boolean=>UUID.test(v);
const validKey=(v:string):boolean=>recurrenceCalendarDateSchema.safeParse(v).success;
/** A real composition locator is all three canonical IDs; a partial or null locator is never attached. */
function realLocator(value:RecurrenceEntityLocator):RecurrenceEntityLocator {
 const id=(v:unknown):string=>{const parsed=idSchema.safeParse(v);if(!parsed.success)throw new TypeError('A recurrence locator needs meeting, task and package IDs.');return parsed.data;};
 return {meetingId:id(value?.meetingId),taskId:id(value?.taskId),workPackageId:id(value?.workPackageId)};
}
/** `col = value`, or `col is null` for a null value: identity predicates of nullable immutable columns. */
const same=(col:AnyColumn,value:string|number|null):SQL=>value===null?isNull(col):eq(col,value);

function conflict(entity:string):DomainError {
 return new DomainError('REVISION_CONFLICT',`The ${entity} changed concurrently. Reload and try again.`);
}
function inconsistent(entity:string):Error {return new Error(`Stored ${entity} is inconsistent with its contract.`);}
function resolution(value:unknown):RecurrenceResolutionDto {
 const parsed=recurrenceResolutionSchema.safeParse(value);if(!parsed.success)throw inconsistent('recurrence resolution');return parsed.data;
}

function series(r:typeof recurrenceSeries.$inferSelect):RecurrenceSeriesRecord {
 return {id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,revision:r.revision,state:r.state,currentVersionId:r.currentVersionId,authorizationId:r.authorizationId,authorizationRevision:r.authorizationRevision,createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt)};
}
function version(r:typeof recurrenceSeriesVersions.$inferSelect):RecurrenceSeriesVersionRecord {
 const parsed=recurrenceSeriesVersionSchema.safeParse({id:r.id,seriesId:r.seriesId,revision:r.revision,effectiveFromNominalDate:r.effectiveFromNominalDate,schedule:r.schedule,template:r.template,policyVersion:r.policyVersion,actorUserId:r.actorUserId,createdAt:iso(r.createdAt),changeSeq:r.changeSeq.toString()});
 if(!parsed.success)throw inconsistent('recurrence series version');return parsed.data;
}
function authorization(r:typeof recurrenceGenerationAuthorizations.$inferSelect):RecurrenceGenerationAuthorizationRecord {
 return {id:r.id,workspaceId:r.workspaceId,seriesId:r.seriesId,revision:r.revision,authorizerUserId:r.authorizerUserId,authorizerMembershipId:r.authorizerMembershipId,actorUserId:r.actorUserId,source:r.source,recordedAt:iso(r.recordedAt),changeSeq:r.changeSeq.toString()};
}
function binding(r:typeof recurrencePeriodBindings.$inferSelect):RecurrencePeriodBindingRecord {
 return {id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,seriesId:r.seriesId,periodId:r.periodId,revision:r.revision,sourceManifestHash:r.sourceManifestHash,createdAt:iso(r.createdAt)};
}
function header(r:typeof recurrenceInstances.$inferSelect):RecurrenceInstanceHeader {
 const present=[r.meetingId,r.taskId,r.workPackageId].filter(v=>v!==null).length;
 if(present!==0&&present!==3)throw inconsistent('recurrence instance locator');
 const locator=r.meetingId!==null&&r.taskId!==null&&r.workPackageId!==null?{meetingId:r.meetingId,taskId:r.taskId,workPackageId:r.workPackageId}:null;
 return {id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,seriesId:r.seriesId,bindingId:r.bindingId,periodId:r.periodId,occurrenceKey:r.occurrenceKey,nominalSequence:r.nominalSequence,sourceVersionId:r.sourceVersionId,revision:r.revision,calendarState:r.calendarState,resolution:resolution(r.resolution),exceptionVersionId:r.exceptionVersionId,locator,createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt)};
}
function exception(r:typeof recurrenceExceptionVersions.$inferSelect):RecurrenceExceptionVersionRecord {
 return {id:r.id,workspaceId:r.workspaceId,instanceId:r.instanceId,revision:r.revision,kind:r.kind,localDate:r.localDate,localTime:r.localTime,reason:r.reason,actorUserId:r.actorUserId,source:r.source,recordedAt:iso(r.recordedAt),changeSeq:r.changeSeq.toString()};
}
function lock(r:typeof recurrenceCalendarLocks.$inferSelect):RecurrenceCalendarLock {
 return {id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,baselineId:r.baselineId,kind:'recurrence_calendar',instanceId:r.instanceId,meetingId:r.meetingId};
}

/**
 * Persistence only, bound to the supplied TX. Every lookup is workspace (and where given project) scoped;
 * immutable identity columns are part of every UPDATE predicate together with the expected head revision.
 * Inserts and updates are explicit (no UPSERT): a missed guard is a REVISION_CONFLICT, never a silent write.
 * Reserved headers keep their natural key, stable ID, binding and period; locators attach exactly once.
 */
export function createRecurrenceRepository(source:Database|WorkloomExecutor,options:RecurrenceRepositoryOptions={}):RecurrenceRepository {
 const db=isDatabase(source)?source.db:source,planning=options.planning??createPlanningRepository(source);
 const writable=(method:string):void=>{if(options.readOnly===true)throw new Error(`Recurrence repository is read-only; ${method} is not allowed in a read.`);};
 const commandSource=():CommandSource=>{if(options.source===undefined)throw new Error('Recurrence writes need the trusted command source of the write scope.');return options.source;};
 const changedAt=():Date=>{if(options.changedAt===undefined)throw new Error('Recurrence writes need the barrier clock of the write scope.');return options.changedAt;};

 async function seriesProject(ws:string,seriesId:string):Promise<string> {
  if(!valid(ws)||!valid(seriesId))throw notFoundError();
  const [r]=await db.select({projectId:recurrenceSeries.projectId}).from(recurrenceSeries).where(and(eq(recurrenceSeries.workspaceId,ws),eq(recurrenceSeries.id,seriesId)));
  if(!r)throw notFoundError();return r.projectId;
 }
 async function instanceProject(ws:string,instanceId:string):Promise<string> {
  if(!valid(ws)||!valid(instanceId))throw notFoundError();
  const [r]=await db.select({projectId:recurrenceInstances.projectId}).from(recurrenceInstances).where(and(eq(recurrenceInstances.workspaceId,ws),eq(recurrenceInstances.id,instanceId)));
  if(!r)throw notFoundError();return r.projectId;
 }

 return {
  planning,
  async findJobReceipt(ws,key){
   const rows=await db.select({payloadHash:commandIdempotency.payloadHash,result:commandIdempotency.result}).from(commandIdempotency).where(and(eq(commandIdempotency.workspaceId,ws),eq(commandIdempotency.command,'recurrence.job.materialize'),eq(commandIdempotency.idempotencyKey,key))).limit(2);
   if(rows.length>1)throw new Error('Duplicate recurrence job receipt under the workspace barrier.');return rows[0]??null;
  },
  async insertJobReceipt(ws,actorUserId,key,payloadHash,result,createdAt){writable('insertJobReceipt');await db.insert(commandIdempotency).values({workspaceId:ws,actorUserId,command:'recurrence.job.materialize',idempotencyKey:key,payloadHash,result,createdAt:new Date(createdAt)});},
  async listSeries(ws,projectId){
   if(!valid(ws)||!valid(projectId))return [];
   return (await db.select().from(recurrenceSeries).where(and(eq(recurrenceSeries.workspaceId,ws),eq(recurrenceSeries.projectId,projectId))).orderBy(asc(recurrenceSeries.id))).map(series);
  },
  async findSeries(ws,id){
   if(!valid(ws)||!valid(id))return null;
   const [r]=await db.select().from(recurrenceSeries).where(and(eq(recurrenceSeries.workspaceId,ws),eq(recurrenceSeries.id,id)));return r?series(r):null;
  },
  async saveSeries(row,exists){
   writable('saveSeries');
   if(!exists){
    await db.insert(recurrenceSeries).values({id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,revision:row.revision,state:row.state,currentVersionId:row.currentVersionId,authorizationId:row.authorizationId,authorizationRevision:row.authorizationRevision,createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)});
    return;
   }
   const changed=await db.update(recurrenceSeries)
    .set({revision:row.revision,state:row.state,currentVersionId:row.currentVersionId,authorizationId:row.authorizationId,authorizationRevision:row.authorizationRevision,updatedAt:new Date(row.updatedAt)})
    .where(and(eq(recurrenceSeries.id,row.id),eq(recurrenceSeries.workspaceId,row.workspaceId),eq(recurrenceSeries.projectId,row.projectId),eq(recurrenceSeries.revision,row.revision-1)))
    .returning({id:recurrenceSeries.id});
   if(changed.length!==1)throw conflict('recurrence series');
  },
  async listSeriesVersions(ws,seriesId){
   if(!valid(ws)||!valid(seriesId))return [];
   return (await db.select().from(recurrenceSeriesVersions).where(and(eq(recurrenceSeriesVersions.workspaceId,ws),eq(recurrenceSeriesVersions.seriesId,seriesId))).orderBy(asc(recurrenceSeriesVersions.revision))).map(version);
  },
  async insertSeriesVersion(row,ws){
   writable('insertSeriesVersion');
   const parsed=recurrenceSeriesVersionSchema.parse(row),projectId=await seriesProject(ws,parsed.seriesId);
   await db.insert(recurrenceSeriesVersions).values({id:parsed.id,workspaceId:ws,projectId,seriesId:parsed.seriesId,revision:parsed.revision,effectiveFromNominalDate:parsed.effectiveFromNominalDate,schedule:parsed.schedule,template:parsed.template,policyVersion:parsed.policyVersion,actorUserId:parsed.actorUserId,source:commandSource(),createdAt:new Date(parsed.createdAt),changeSeq:BigInt(parsed.changeSeq)});
  },
  async findAuthorization(ws,id){
   if(!valid(ws)||!valid(id))return null;
   const [r]=await db.select().from(recurrenceGenerationAuthorizations).where(and(eq(recurrenceGenerationAuthorizations.workspaceId,ws),eq(recurrenceGenerationAuthorizations.id,id)));return r?authorization(r):null;
  },
  async insertAuthorization(row){
   writable('insertAuthorization');
   const projectId=await seriesProject(row.workspaceId,row.seriesId);
   await db.insert(recurrenceGenerationAuthorizations).values({id:row.id,workspaceId:row.workspaceId,projectId,seriesId:row.seriesId,revision:row.revision,authorizerUserId:row.authorizerUserId,authorizerMembershipId:row.authorizerMembershipId,actorUserId:row.actorUserId,source:row.source,recordedAt:new Date(row.recordedAt),changeSeq:BigInt(row.changeSeq)});
  },
  async listBindings(ws,seriesId){
   if(!valid(ws)||!valid(seriesId))return [];
   return (await db.select().from(recurrencePeriodBindings).where(and(eq(recurrencePeriodBindings.workspaceId,ws),eq(recurrencePeriodBindings.seriesId,seriesId))).orderBy(asc(recurrencePeriodBindings.createdAt),asc(recurrencePeriodBindings.id))).map(binding);
  },
  async listBindingsForPeriod(ws,periodId){
   if(!valid(ws)||!valid(periodId))return [];
   return (await db.select().from(recurrencePeriodBindings).where(and(eq(recurrencePeriodBindings.workspaceId,ws),eq(recurrencePeriodBindings.periodId,periodId))).orderBy(asc(recurrencePeriodBindings.seriesId),asc(recurrencePeriodBindings.id))).map(binding);
  },
  async findBinding(ws,id){
   if(!valid(ws)||!valid(id))return null;
   const [r]=await db.select().from(recurrencePeriodBindings).where(and(eq(recurrencePeriodBindings.workspaceId,ws),eq(recurrencePeriodBindings.id,id)));return r?binding(r):null;
  },
  async saveBinding(row,exists){
   writable('saveBinding');
   const hash=recurrenceHashSchema.parse(row.sourceManifestHash);
   if(!exists){
    await db.insert(recurrencePeriodBindings).values({id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,seriesId:row.seriesId,periodId:row.periodId,revision:row.revision,sourceManifestHash:hash,createdAt:new Date(row.createdAt)});
    return;
   }
   // Series, period and project are immutable: a binding is never retargeted, even after cancel.
   const changed=await db.update(recurrencePeriodBindings).set({revision:row.revision,sourceManifestHash:hash})
    .where(and(eq(recurrencePeriodBindings.id,row.id),eq(recurrencePeriodBindings.workspaceId,row.workspaceId),eq(recurrencePeriodBindings.projectId,row.projectId),eq(recurrencePeriodBindings.seriesId,row.seriesId),eq(recurrencePeriodBindings.periodId,row.periodId),eq(recurrencePeriodBindings.revision,row.revision-1)))
    .returning({id:recurrencePeriodBindings.id});
   if(changed.length!==1)throw conflict('recurrence period binding');
  },
  async listInstanceHeaders(ws,bindingId){
   if(!valid(ws)||!valid(bindingId))return [];
   return (await db.select().from(recurrenceInstances).where(and(eq(recurrenceInstances.workspaceId,ws),eq(recurrenceInstances.bindingId,bindingId))).orderBy(asc(recurrenceInstances.occurrenceKey),asc(recurrenceInstances.id))).map(header);
  },
  async findInstanceHeader(ws,seriesId,occurrenceKey){
   if(!valid(ws)||!valid(seriesId)||!validKey(occurrenceKey))return null;
   const [r]=await db.select().from(recurrenceInstances).where(and(eq(recurrenceInstances.workspaceId,ws),eq(recurrenceInstances.seriesId,seriesId),eq(recurrenceInstances.occurrenceKey,occurrenceKey)));return r?header(r):null;
  },
  async reserveInstanceHeaders(rows){
   writable('reserveInstanceHeaders');
   if(rows.length===0)return;
   const groups=new Map<string,RecurrenceInstanceHeader[]>();
   for(const row of rows){
    if(row.locator!==null)throw new TypeError('Reserved recurrence headers carry no locator; attach it with attachInstanceLocator.');
    if(!validKey(row.occurrenceKey))throw new TypeError('Reserved recurrence headers need a valid occurrence key.');
    const key=`${row.workspaceId.toLowerCase()}:${row.seriesId.toLowerCase()}`,group=groups.get(key)??[];
    if(group.some(g=>g.occurrenceKey===row.occurrenceKey))throw new TypeError('Duplicate natural key in one reservation.');
    group.push(row);groups.set(key,group);
   }
   const missing:RecurrenceInstanceHeader[]=[];
   for(const group of groups.values()){
    const first=group[0];if(first===undefined)continue;
    const existing=await db.select().from(recurrenceInstances).where(and(eq(recurrenceInstances.workspaceId,first.workspaceId),eq(recurrenceInstances.seriesId,first.seriesId),inArray(recurrenceInstances.occurrenceKey,group.map(g=>g.occurrenceKey))));
    const byKey=new Map(existing.map(r=>[r.occurrenceKey,r]));
    for(const row of group){
     const current=byKey.get(row.occurrenceKey);
     if(current===undefined){missing.push(row);continue;}
     // An existing natural key keeps its stable ID, binding, period and original sequence; never retargeted.
     if(current.projectId!==row.projectId.toLowerCase()||current.bindingId!==row.bindingId.toLowerCase()||current.periodId!==row.periodId.toLowerCase()||current.nominalSequence!==row.nominalSequence)throw conflict('recurrence instance header');
    }
   }
   if(missing.length===0)return;
   await db.insert(recurrenceInstances).values(missing.map(row=>({
    id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,seriesId:row.seriesId,bindingId:row.bindingId,periodId:row.periodId,
    occurrenceKey:row.occurrenceKey,nominalSequence:row.nominalSequence,sourceVersionId:row.sourceVersionId,revision:row.revision,
    calendarState:row.calendarState,resolution:resolution(row.resolution),exceptionVersionId:row.exceptionVersionId,
    meetingId:null,taskId:null,workPackageId:null,createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt),
   })));
  },
  async saveInstanceHeader(row){
   writable('saveInstanceHeader');
   const locator=row.locator;
   // Identity, natural key, sequence, binding/period and the current locator are immutable here; locators attach only via attachInstanceLocator.
   const changed=await db.update(recurrenceInstances)
    .set({revision:row.revision,sourceVersionId:row.sourceVersionId,calendarState:row.calendarState,resolution:resolution(row.resolution),exceptionVersionId:row.exceptionVersionId,updatedAt:new Date(row.updatedAt)})
    .where(and(
     eq(recurrenceInstances.id,row.id),eq(recurrenceInstances.workspaceId,row.workspaceId),eq(recurrenceInstances.projectId,row.projectId),
     eq(recurrenceInstances.seriesId,row.seriesId),eq(recurrenceInstances.bindingId,row.bindingId),eq(recurrenceInstances.periodId,row.periodId),
     eq(recurrenceInstances.occurrenceKey,row.occurrenceKey),same(recurrenceInstances.nominalSequence,row.nominalSequence),
     same(recurrenceInstances.meetingId,locator?.meetingId??null),same(recurrenceInstances.taskId,locator?.taskId??null),same(recurrenceInstances.workPackageId,locator?.workPackageId??null),
     eq(recurrenceInstances.revision,row.revision-1),
    ))
    .returning({id:recurrenceInstances.id});
   if(changed.length!==1)throw conflict('recurrence instance header');
  },
  async attachInstanceLocator(ws,instanceId,expectedRevision,locator){
   writable('attachInstanceLocator');
   if(!valid(ws)||!valid(instanceId))throw notFoundError();
   const parsed=realLocator(locator);
   const changed=await db.update(recurrenceInstances)
    .set({meetingId:parsed.meetingId,taskId:parsed.taskId,workPackageId:parsed.workPackageId,revision:expectedRevision+1,updatedAt:changedAt()})
    .where(and(eq(recurrenceInstances.workspaceId,ws),eq(recurrenceInstances.id,instanceId),eq(recurrenceInstances.revision,expectedRevision),isNull(recurrenceInstances.meetingId),isNull(recurrenceInstances.taskId),isNull(recurrenceInstances.workPackageId)))
    .returning({id:recurrenceInstances.id});
   if(changed.length!==1)throw conflict('recurrence instance header');
  },
  async listExceptionVersions(ws,instanceId){
   if(!valid(ws)||!valid(instanceId))return [];
   return (await db.select().from(recurrenceExceptionVersions).where(and(eq(recurrenceExceptionVersions.workspaceId,ws),eq(recurrenceExceptionVersions.instanceId,instanceId))).orderBy(asc(recurrenceExceptionVersions.revision))).map(exception);
  },
  async insertExceptionVersion(row){
   writable('insertExceptionVersion');
   if((row.kind==='move')!==(row.localDate!==null&&row.localTime!==null)||(row.kind!=='move'&&(row.localDate!==null||row.localTime!==null)))throw new TypeError('Only move exceptions carry a local date and time.');
   const projectId=await instanceProject(row.workspaceId,row.instanceId);
   await db.insert(recurrenceExceptionVersions).values({id:row.id,workspaceId:row.workspaceId,projectId,instanceId:row.instanceId,revision:row.revision,kind:row.kind,localDate:row.localDate,localTime:row.localTime,reason:row.reason,actorUserId:row.actorUserId,source:row.source,recordedAt:new Date(row.recordedAt),changeSeq:BigInt(row.changeSeq)});
  },
  async listCalendarLocks(ws,instanceId){
   if(!valid(ws)||!valid(instanceId))return [];
   return (await db.select().from(recurrenceCalendarLocks).where(and(eq(recurrenceCalendarLocks.workspaceId,ws),eq(recurrenceCalendarLocks.instanceId,instanceId))).orderBy(asc(recurrenceCalendarLocks.id))).map(lock);
  },
  async insertCalendarLocks(rows){
   writable('insertCalendarLocks');
   if(rows.length===0)return;
   for(const row of rows)if(row.kind!=='recurrence_calendar')throw new TypeError('Only calendar-only recurrence locks are stored here.');
   await db.insert(recurrenceCalendarLocks).values(rows.map(row=>({id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,baselineId:row.baselineId,instanceId:row.instanceId,meetingId:row.meetingId})));
  },
 };
}
