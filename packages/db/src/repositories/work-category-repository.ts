import {and,asc,eq} from 'drizzle-orm';
import {notFoundError,type WorkCategoryRepository} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {projectWorkCategoryBindings,projectWorkCategoryBindingVersions,workLogs,workTypeReportRuns} from '../schema.js';
import {createPlanningRepository} from './planning-repository.js';

/** Persistence only; every lookup/update is tenant scoped, all sources use the same TX. */
export function createWorkCategoryRepository(source:Database|WorkloomExecutor):WorkCategoryRepository {
 const db=isDatabase(source)?source.db:source,planning=createPlanningRepository(source);
 return {
  planning,
  async findBinding(ws,projectId){const [r]=await db.select().from(projectWorkCategoryBindings).where(and(eq(projectWorkCategoryBindings.workspaceId,ws),eq(projectWorkCategoryBindings.projectId,projectId)));return r??null;},
  async saveBinding(row,exists){
   if(!exists){await db.insert(projectWorkCategoryBindings).values(row);return;}
   const saved=await db.update(projectWorkCategoryBindings).set({fieldId:row.fieldId,versionId:row.versionId,revision:row.revision}).where(and(eq(projectWorkCategoryBindings.workspaceId,row.workspaceId),eq(projectWorkCategoryBindings.projectId,row.projectId),eq(projectWorkCategoryBindings.revision,row.revision-1))).returning({id:projectWorkCategoryBindings.projectId});
   if(!saved.length)throw notFoundError();
  },
  async insertBindingVersion(row){await db.insert(projectWorkCategoryBindingVersions).values({id:row.versionId,workspaceId:row.workspaceId,projectId:row.projectId,revision:row.revision,fieldId:row.fieldId,actorUserId:row.actorUserId,recordedAt:new Date(row.recordedAt),changeSeq:BigInt(row.changeSeq)});},
  async findWorkLog(ws,id){const [r]=await db.select({periodId:workLogs.periodId}).from(workLogs).where(and(eq(workLogs.workspaceId,ws),eq(workLogs.id,id)));return r?(await planning.listRecordedWork(ws,r.periodId)).find(w=>w.id===id)??null:null;},
  async listReportRuns(ws,periodId){return (await db.select({document:workTypeReportRuns.document}).from(workTypeReportRuns).where(and(eq(workTypeReportRuns.workspaceId,ws),eq(workTypeReportRuns.periodId,periodId))).orderBy(asc(workTypeReportRuns.id))).map(r=>r.document);},
  async findReportRun(ws,id){const [r]=await db.select().from(workTypeReportRuns).where(and(eq(workTypeReportRuns.workspaceId,ws),eq(workTypeReportRuns.id,id)));return r?{run:r.document,rows:r.rows}:null;},
  async insertReportRun(run,rows){await db.insert(workTypeReportRuns).values({id:run.id,workspaceId:run.workspaceId,projectId:run.projectId,periodId:run.periodId,document:run,rows,createdAt:new Date(run.createdAt)});},
 };
}
