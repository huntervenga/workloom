import {createHash} from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  RecordedWorkLogDto,AttendanceWorkLogDto,
  PackageBaselineDto, PlanBaselineDto,
  PlanningPeriodDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto,
} from '@workloom/contracts';
import { DomainError,assessmentOf,evaluatePeriodCensus,snapshotSectionOf,createRecurrenceOccurrenceResolver,legacyWorkCategory, notFoundError, type PackageFreezeObservation, type PlanningLock, type PlanningRepository } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import {
  meetings,meetingAttendances,meetingScheduleLocks,
  commitmentAllocations, memberships, packageBaselines, packageFreezeObservations,
  periodCommitmentRevisions, periodCommitments, planBaselines, planningLocks, planningPeriods,
  tasks, users, weeklyReportRuns, workLogRevisions, workLogs, workPackages, workspaces,
} from '../schema.js';
import { createTaskFieldRepository } from './task-field-repository.js';
import { createTaskRepository } from './task-repository.js';
import {createRecurrenceRepository} from './recurrence-repository.js';

const iso = (v:Date):string => v.toISOString();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid=(v:string):boolean=>UUID.test(v);
function period(r:typeof planningPeriods.$inferSelect):PlanningPeriodDto {
  return {...r,cutoffAt:iso(r.cutoffAt),createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt)};
}
function baseline(r:typeof planBaselines.$inferSelect):PlanBaselineDto {
  return {...r,requestedCutoffAt:iso(r.requestedCutoffAt),frozenAt:iso(r.frozenAt),changeSeq:r.changeSeq.toString()};
}
function packageBaseline(r:typeof packageBaselines.$inferSelect):PackageBaselineDto {
  return {...r,acceptedAt:iso(r.acceptedAt),provenance:'first_known_plan_freeze'};
}

export function projectRecordedWork(l:typeof workLogs.$inferSelect,v:typeof workLogRevisions.$inferSelect):RecordedWorkLogDto {
 const base={id:l.id,workspaceId:l.workspaceId,projectId:l.projectId,taskId:l.taskId,workPackageId:l.workPackageId,membershipId:l.membershipId,periodId:l.periodId,sourceKey:l.sourceKey,revision:v.revision,revisionId:v.id,minutes:v.minutes,state:v.state,reason:v.reason,actorUserId:v.actorUserId,recordedAt:iso(v.recordedAt),changeSeq:v.changeSeq.toString(),category:v.category??legacyWorkCategory()};
 if(l.sourceKind==='manual_period')return {...base,sourceKind:'manual_period',precision:'period'};
 if(l.sourceKind!=='meeting_attendance'||!l.meetingId||!l.attendanceId||!v.confirmedMeetingRevision||!v.attribution)throw new Error('Stored occurrence source is inconsistent.');
 return {...base,sourceKind:'meeting_attendance',precision:'occurrence',meetingId:l.meetingId,attendanceId:l.attendanceId,confirmedMeetingRevision:v.confirmedMeetingRevision,attribution:v.attribution};
}
/** Persistence only. Every read and write is workspace scoped and bound to the supplied TX. */
export function createPlanningRepository(source:Database|WorkloomExecutor):PlanningRepository {
  const db=isDatabase(source)?source.db:source;
  const taskRepo=createTaskRepository(source);
  const fieldRepo=createTaskFieldRepository(source);
  const repo:PlanningRepository={
    tasks:taskRepo, fields:fieldRepo,
    async captureRecurrenceSnapshot(period,kind,memberId) {
      const recurrence=createRecurrenceRepository(db,{planning:repo,readOnly:true});
      const resolver=createRecurrenceOccurrenceResolver({tzdataVersion:process.versions.tz??null,icuVersion:process.versions.icu??null});
      const [clock]=await db.execute<{at:Date|string}>(sql`select clock_timestamp() as at`);
      const evaluated=await evaluatePeriodCensus(recurrence,{resolver,digest:value=>createHash('sha256').update(value,'utf8').digest('hex')},period,new Date(clock?.at??Date.now()));
      const assessment=assessmentOf(period.id,evaluated);
      if(assessment.status!=='complete')throw new DomainError('MATERIALIZATION_REQUIRED','Prepare the registered recurring meetings before reviewing this freeze.');
      return snapshotSectionOf(recurrence,resolver.policyVersion,evaluated,kind,memberId);
    },
    async currentChangeSeq(ws) {const [r]=await db.select({seq:workspaces.changeSeq}).from(workspaces).where(eq(workspaces.id,ws));if(!r)throw notFoundError();return r.seq.toString();},
    async captureProject(ws,projectId) {
      const [packageRows,taskRows,memberRows,fields,baselineRows]=await Promise.all([
        db.select().from(workPackages).where(and(eq(workPackages.workspaceId,ws),eq(workPackages.projectId,projectId))).orderBy(asc(workPackages.id)),
        db.select({id:tasks.id}).from(tasks).where(and(eq(tasks.workspaceId,ws),eq(tasks.projectId,projectId))).orderBy(asc(tasks.position),asc(tasks.id)),
        db.select({membership:memberships,displayName:users.displayName}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(eq(memberships.workspaceId,ws)).orderBy(asc(memberships.id)),
        fieldRepo.listFields(ws,projectId),
        db.select().from(packageBaselines).where(and(eq(packageBaselines.workspaceId,ws),eq(packageBaselines.projectId,projectId))),
      ]);
      const projected=await Promise.all(taskRows.map(t=>taskRepo.findTask(ws,t.id)));
      const allTasks=projected.filter(t=>t!==null);
      const values=await fieldRepo.listProjectValues(ws,projectId,taskRows.map(t=>t.id));
      return {
        packages:packageRows.map(p=>({id:p.id,projectId:p.projectId,revision:p.revision,estimateMinutes:p.estimateMinutes,createdAt:iso(p.createdAt),packageBaselineId:baselineRows.find(b=>b.workPackageId===p.id)?.id??null,title:allTasks.find(t=>t.workPackageId===p.id)?.title??'Пакет задач'})),
        tasks:allTasks,fields,values,
        memberships:memberRows.map(({membership:m,displayName})=>({id:m.id,workspaceId:m.workspaceId,userId:m.userId,displayName,role:m.role})),
        activeMembershipIds:memberRows.filter(r=>r.membership.state==='active').map(r=>r.membership.id),
      };
    },
    async listPeriods(ws,projectId) {
      const rows=await db.select().from(planningPeriods).where(projectId===undefined?eq(planningPeriods.workspaceId,ws):and(eq(planningPeriods.workspaceId,ws),eq(planningPeriods.projectId,projectId))).orderBy(asc(planningPeriods.id));
      return rows.map(period);
    },
    async findPeriod(ws,id) {if(!valid(id))return null;const [r]=await db.select().from(planningPeriods).where(and(eq(planningPeriods.workspaceId,ws),eq(planningPeriods.id,id)));return r?period(r):null;},
    async insertPeriod(row) {await db.insert(planningPeriods).values({...row,cutoffAt:new Date(row.cutoffAt),createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)});},
    async savePeriod(row) {await db.update(planningPeriods).set({...row,cutoffAt:new Date(row.cutoffAt),createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)}).where(and(eq(planningPeriods.workspaceId,row.workspaceId),eq(planningPeriods.id,row.id)));},
    async listCommitments(ws,periodId) {
      const rows=await db.select().from(periodCommitments).where(and(eq(periodCommitments.workspaceId,ws),eq(periodCommitments.periodId,periodId))).orderBy(asc(periodCommitments.id));
      if(rows.length===0)return [];
      const ids=rows.map(r=>r.id);
      const [allocations,locks]=await Promise.all([
        db.select().from(commitmentAllocations).where(and(eq(commitmentAllocations.workspaceId,ws),inArray(commitmentAllocations.commitmentId,ids))).orderBy(asc(commitmentAllocations.taskId)),
        db.select().from(planningLocks).where(and(eq(planningLocks.workspaceId,ws),inArray(planningLocks.commitmentId,ids))),
      ]);
      return rows.map(({added,...r})=>{
        const own=allocations.filter(a=>a.commitmentId===r.id).map(a=>({taskId:a.taskId,minutes:a.minutes}));
        return {...r,allocations:own,unallocatedMinutes:r.plannedMinutes===null?null:r.plannedMinutes-own.reduce((a,v)=>a+v.minutes,0),classification:added?'added':'planned',baselineIds:locks.filter(l=>l.commitmentId===r.id).map(l=>l.baselineId),createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt)};
      });
    },
    async findCommitment(ws,id) {
      if(!valid(id))return null;const [r]=await db.select({periodId:periodCommitments.periodId}).from(periodCommitments).where(and(eq(periodCommitments.workspaceId,ws),eq(periodCommitments.id,id)));
      return r?(await repo.listCommitments(ws,r.periodId)).find(c=>c.id===id)??null:null;
    },
    async saveCommitment(row) {
      const {allocations,unallocatedMinutes:_unallocated,classification,baselineIds:_baselines,...core}=row;
      const values={...core,added:classification==='added',createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)};
      const saved=await db.insert(periodCommitments).values(values).onConflictDoUpdate({target:periodCommitments.id,set:{plannedMinutes:row.plannedMinutes,state:row.state,added:row.classification==='added',revision:row.revision,updatedAt:new Date(row.updatedAt)},setWhere:sql`${and(eq(periodCommitments.workspaceId,row.workspaceId),eq(periodCommitments.projectId,row.projectId),eq(periodCommitments.periodId,row.periodId),eq(periodCommitments.workPackageId,row.workPackageId),eq(periodCommitments.membershipId,row.membershipId))}`}).returning({id:periodCommitments.id});
      if(saved.length===0)throw notFoundError();
      await db.delete(commitmentAllocations).where(and(eq(commitmentAllocations.workspaceId,row.workspaceId),eq(commitmentAllocations.commitmentId,row.id)));
      if(allocations.length)await db.insert(commitmentAllocations).values(allocations.map(a=>({...a,workspaceId:row.workspaceId,projectId:row.projectId,commitmentId:row.id})));
    },
    async insertCommitmentRevision(row,actorUserId,changeSeq,revisionId) {
      await db.insert(periodCommitmentRevisions).values({id:revisionId,workspaceId:row.workspaceId,commitmentId:row.id,revision:row.revision,snapshot:row,actorUserId,recordedAt:new Date(row.updatedAt),changeSeq});
    },
    async listBaselines(ws,periodId) {return (await db.select().from(planBaselines).where(and(eq(planBaselines.workspaceId,ws),eq(planBaselines.periodId,periodId))).orderBy(asc(planBaselines.id))).map(baseline);},
    async findBaseline(ws,id) {if(!valid(id))return null;const [r]=await db.select().from(planBaselines).where(and(eq(planBaselines.workspaceId,ws),eq(planBaselines.id,id)));return r?baseline(r):null;},
    async insertBaseline(row) {await db.insert(planBaselines).values({...row,requestedCutoffAt:new Date(row.requestedCutoffAt),frozenAt:new Date(row.frozenAt),changeSeq:BigInt(row.changeSeq)});},
    async findPackageBaseline(ws,id) {if(!valid(id))return null;const [r]=await db.select().from(packageBaselines).where(and(eq(packageBaselines.workspaceId,ws),eq(packageBaselines.id,id)));return r?packageBaseline(r):null;},
    async findPackageBaselineForPackage(ws,id) {if(!valid(id))return null;const [r]=await db.select().from(packageBaselines).where(and(eq(packageBaselines.workspaceId,ws),eq(packageBaselines.workPackageId,id)));return r?packageBaseline(r):null;},
    async insertPackageBaseline(row) {const {provenance:_provenance,...values}=row;await db.insert(packageBaselines).values({...values,acceptedAt:new Date(row.acceptedAt)});},
    async findPackageObservation(ws,id) {
      const [r]=await db.select().from(packageFreezeObservations).where(and(eq(packageFreezeObservations.workspaceId,ws),eq(packageFreezeObservations.workPackageId,id)));
      return r?{workspaceId:r.workspaceId,projectId:r.projectId,workPackageId:r.workPackageId,estimateMinutes:r.estimateMinutes,packageRevision:r.packageRevision,baselineId:r.baselineId}:null;
    },
    async insertPackageObservation(row:PackageFreezeObservation) {await db.insert(packageFreezeObservations).values(row);},
    async listLocks(ws) {return db.select().from(planningLocks).where(eq(planningLocks.workspaceId,ws));},
    async insertLocks(rows:PlanningLock[]) {if(rows.length)await db.insert(planningLocks).values(rows);},
    async listMeetings(ws,projectId) {
      const rows=await db.select().from(meetings).where(and(eq(meetings.workspaceId,ws),eq(meetings.projectId,projectId))).orderBy(asc(meetings.id));
      const locks=await db.select().from(meetingScheduleLocks).where(eq(meetingScheduleLocks.workspaceId,ws));
      const posted=await db.select({meetingId:workLogs.meetingId}).from(workLogs).where(and(eq(workLogs.workspaceId,ws),eq(workLogs.projectId,projectId),eq(workLogs.sourceKind,'meeting_attendance')));
      return rows.map(r=>({...r.document,scheduleFrozen:locks.some(l=>l.meetingId===r.id)||posted.some(w=>w.meetingId===r.id),hasPostedAttendance:posted.some(w=>w.meetingId===r.id)}));
    },
    async findMeetingByTask(ws,taskId) {const [r]=await db.select({projectId:meetings.projectId}).from(meetings).where(and(eq(meetings.workspaceId,ws),eq(meetings.taskId,taskId)));return r?(await repo.listMeetings(ws,r.projectId)).find(m=>m.taskId===taskId)??null:null;},
    async listAttendance(ws,meetingId) {
      const rows=await db.select().from(meetingAttendances).where(and(eq(meetingAttendances.workspaceId,ws),eq(meetingAttendances.meetingId,meetingId))).orderBy(asc(meetingAttendances.id));
      const [m]=await db.select({periodId:meetings.plannedPeriodId}).from(meetings).where(and(eq(meetings.workspaceId,ws),eq(meetings.id,meetingId)));
      const work=m?await repo.listRecordedWork(ws,m.periodId):[];
      return rows.map(r=>({...r.document,workLog:work.find((w):w is AttendanceWorkLogDto=>w.sourceKind==='meeting_attendance'&&w.attendanceId===r.id)??null}));
    },
    async listMeetingLocks(ws,meetingId) {return db.select({baselineId:meetingScheduleLocks.baselineId}).from(meetingScheduleLocks).where(and(eq(meetingScheduleLocks.workspaceId,ws),eq(meetingScheduleLocks.meetingId,meetingId)));},
    async insertMeetingLock(ws,meetingId,baselineId,id) {await db.insert(meetingScheduleLocks).values({id,workspaceId:ws,meetingId,baselineId});},
    async listRecordedWork(ws,periodId) {
      const rows=await db.select({log:workLogs,version:workLogRevisions}).from(workLogs).innerJoin(workLogRevisions,and(eq(workLogRevisions.workspaceId,workLogs.workspaceId),eq(workLogRevisions.workLogId,workLogs.id),eq(workLogRevisions.id,workLogs.revisionId),eq(workLogRevisions.revision,workLogs.revision))).where(and(eq(workLogs.workspaceId,ws),eq(workLogs.periodId,periodId))).orderBy(asc(workLogs.id));
      return rows.map(({log,version})=>projectRecordedWork(log,version));
    },
    async listWorkLogs(ws,periodId) {return (await repo.listRecordedWork(ws,periodId)).filter(w=>w.sourceKind==='manual_period');},
    async findManualWork(ws,taskId,periodId,memberId) {return (await repo.listWorkLogs(ws,periodId)).find(w=>w.taskId===taskId&&w.membershipId===memberId)??null;},
    async saveManualWork(row) {await repo.saveRecordedWork(row);},
    async saveRecordedWork(row) {
      const values={id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,taskId:row.taskId,workPackageId:row.workPackageId,membershipId:row.membershipId,periodId:row.periodId,sourceKind:row.sourceKind,sourceKey:row.sourceKey,meetingId:row.sourceKind==='meeting_attendance'?row.meetingId:null,attendanceId:row.sourceKind==='meeting_attendance'?row.attendanceId:null,revision:row.revision,revisionId:row.revisionId};
      if(row.revision===1) {await db.insert(workLogs).values(values);return;}
      // BEFORE INSERT triggers run before ON CONFLICT resolution: revisions use UPDATE.
      const saved=await db.update(workLogs).set({revision:row.revision,revisionId:row.revisionId}).where(and(eq(workLogs.id,row.id),eq(workLogs.workspaceId,row.workspaceId),eq(workLogs.projectId,row.projectId),eq(workLogs.taskId,row.taskId),eq(workLogs.workPackageId,row.workPackageId),eq(workLogs.membershipId,row.membershipId),eq(workLogs.periodId,row.periodId),eq(workLogs.sourceKind,row.sourceKind),eq(workLogs.sourceKey,row.sourceKey),eq(workLogs.revision,row.revision-1))).returning({id:workLogs.id});
      if(saved.length===0)throw notFoundError();
    },
    async insertWorkRevision(row) {await db.insert(workLogRevisions).values({id:row.revisionId,workspaceId:row.workspaceId,workLogId:row.id,revision:row.revision,minutes:row.minutes,state:row.state,reason:row.reason,actorUserId:row.actorUserId,recordedAt:new Date(row.recordedAt),changeSeq:BigInt(row.changeSeq),meetingId:row.sourceKind==='meeting_attendance'?row.meetingId:null,attendanceId:row.sourceKind==='meeting_attendance'?row.attendanceId:null,confirmedMeetingRevision:row.sourceKind==='meeting_attendance'?row.confirmedMeetingRevision:null,attribution:row.sourceKind==='meeting_attendance'?row.attribution:null,category:row.category??null,categoryProjectId:row.category?row.projectId:null,categoryBindingVersionId:row.category?.bindingVersionId??null,categoryBindingRevision:row.category?.bindingRevision??null,categoryFieldId:row.category?.fieldId??null,categoryDefinitionVersionId:row.category?.kind==='categorized'?row.category.fieldDefinitionVersionId:null,categoryOptionId:row.category?.kind==='categorized'?row.category.optionId:null,categoryOptionRevision:row.category?.kind==='categorized'?row.category.optionRevision:null});},
    async listReportRuns(ws,periodId) {return (await db.select({document:weeklyReportRuns.document}).from(weeklyReportRuns).where(and(eq(weeklyReportRuns.workspaceId,ws),eq(weeklyReportRuns.periodId,periodId))).orderBy(asc(weeklyReportRuns.id))).map(r=>r.document);},
    async findReportRun(ws,id) {if(!valid(id))return null;const [r]=await db.select().from(weeklyReportRuns).where(and(eq(weeklyReportRuns.workspaceId,ws),eq(weeklyReportRuns.id,id)));return r?{run:r.document,rows:r.rows}:null;},
    async insertReportRun(run:WeeklyPlanFactReportRunDto,rows:WeeklyPlanFactRowDto[]) {await db.insert(weeklyReportRuns).values({id:run.id,workspaceId:run.workspaceId,projectId:run.projectId,periodId:run.periodId,baselineId:run.baselineId,document:run,rows,createdAt:new Date(run.createdAt)});},
  };
  return repo;
}
