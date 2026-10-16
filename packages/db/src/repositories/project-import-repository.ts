import {and,eq,inArray,sql} from 'drizzle-orm';
import type {ProjectImportRepository,StoredProjectImport} from '@workloom/domain';
import {notFoundError} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {projectImports,externalImportReferences,workspaces} from '../schema.js';
function project(r:typeof projectImports.$inferSelect):StoredProjectImport{return {artifact:{id:r.id,workspaceId:r.workspaceId,projectId:r.projectId,sourceNamespace:r.sourceNamespace,fileName:r.fileName,fileDigest:r.fileDigest,revision:r.revision,status:r.status,headers:r.headers,sourceRows:r.sourceRows,createdAt:r.createdAt.toISOString(),appliedAt:r.appliedAt?.toISOString()??null},rawCsv:r.rawCsv,reconciliation:r.reconciliation};}
export function createProjectImportRepository(source:Database|WorkloomExecutor):ProjectImportRepository {
 const db=isDatabase(source)?source.db:source;
 return {
 async findImport(ws,id){const [r]=await db.select().from(projectImports).where(and(eq(projectImports.workspaceId,ws),eq(projectImports.id,id)));return r?project(r):null;},
 async insertImport(row){const a=row.artifact;await db.insert(projectImports).values({...a,createdAt:new Date(a.createdAt),appliedAt:null,rawCsv:row.rawCsv,reconciliation:null});},
 async saveAppliedImport(row){const a=row.artifact;const updated=await db.update(projectImports).set({status:a.status,revision:a.revision,appliedAt:a.appliedAt?new Date(a.appliedAt):null,reconciliation:row.reconciliation}).where(and(eq(projectImports.workspaceId,a.workspaceId),eq(projectImports.projectId,a.projectId),eq(projectImports.id,a.id),eq(projectImports.revision,1),eq(projectImports.status,'staged'))).returning({id:projectImports.id});if(!updated.length)throw notFoundError();},
 async findReferences(ws,namespace,ids){if(!ids.length)return [];return (await db.select().from(externalImportReferences).where(and(eq(externalImportReferences.workspaceId,ws),eq(externalImportReferences.sourceNamespace,namespace),inArray(externalImportReferences.externalId,[...ids])))).map(r=>({...r,createdAt:r.createdAt.toISOString()}));},
 async insertReference(row){await db.insert(externalImportReferences).values({...row,createdAt:new Date(row.createdAt)});},
 async currentChangeSeq(ws){const [r]=await db.select({seq:sql<string>`${workspaces.changeSeq}::text`}).from(workspaces).where(eq(workspaces.id,ws));if(!r)throw notFoundError();return r.seq;},
 };
}
