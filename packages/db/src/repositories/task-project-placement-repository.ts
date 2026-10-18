import {and,asc,eq,gt,isNull,or,sql} from 'drizzle-orm';
import type {TaskProjectPlacementDto} from '@workloom/contracts';
import {notFoundError,type TaskProjectPlacementRepository} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {taskProjectPlacements as placements,tasks} from '../schema.js';
function dto(row:typeof placements.$inferSelect):TaskProjectPlacementDto {return {...row,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),archivedAt:row.archivedAt?.toISOString()??null};}
export function createTaskProjectPlacementRepository(source:Database|WorkloomExecutor):TaskProjectPlacementRepository {
 const db:WorkloomExecutor=isDatabase(source)?source.db:source;
 return {
  async find(ws,id){const [row]=await db.select().from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.id,id)));return row?dto(row):null;},
  async findForTaskProject(ws,taskId,projectId){const [row]=await db.select().from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.taskId,taskId),eq(placements.projectId,projectId)));return row?dto(row):null;},
  async listForTask(ws,taskId,take){return (await db.select().from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.taskId,taskId))).orderBy(asc(placements.projectId),asc(placements.id)).limit(take)).map(dto);},
  async listProject(ws,projectId,includeArchived,after,take){
   if(after!==null&&!('position' in after))throw new Error('Project placement pages require position cursors.');
   return (await db.select({placement:placements}).from(placements).innerJoin(tasks,and(eq(tasks.workspaceId,placements.workspaceId),eq(tasks.id,placements.taskId))).where(and(eq(placements.workspaceId,ws),eq(placements.projectId,projectId),includeArchived?undefined:and(isNull(placements.archivedAt),isNull(tasks.archivedAt)),after===null?undefined:or(gt(placements.position,after.position),and(eq(placements.position,after.position),gt(placements.id,after.id))))).orderBy(asc(placements.position),asc(placements.id)).limit(take)).map(row=>dto(row.placement));
  },
  async maxPosition(ws,projectId){const [row]=await db.select({max:sql<number>`coalesce(max(${placements.position}), -1)::integer`}).from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.projectId,projectId)));return row?.max??-1;},
  async insert(row){await db.insert(placements).values({...row,archivedAt:row.archivedAt===null?null:new Date(row.archivedAt),createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)});},
  async save(row){const updated=await db.update(placements).set({sectionId:row.sectionId,position:row.position,revision:row.revision,archivedAt:row.archivedAt===null?null:new Date(row.archivedAt),updatedAt:new Date(row.updatedAt)}).where(and(eq(placements.workspaceId,row.workspaceId),eq(placements.id,row.id),eq(placements.revision,row.revision-1))).returning({id:placements.id});if(updated.length!==1)throw notFoundError();},
 };
}
