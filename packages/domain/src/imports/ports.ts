import type {ProjectImportDto,ProjectImportReconciliationDto,ImportOwnedRevisions} from '@workloom/contracts';
import type {PlanningWriteScope,PlanningRepository,PlanningTools} from '../planning/ports.js';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {WorkspaceAccessRecord} from '../access/ports.js';
import type {RecurrenceScopedMaterializer} from '../recurrence/ports.js';
export interface ExternalImportReference {readonly workspaceId:string;readonly sourceNamespace:string;readonly externalId:string;readonly projectId:string;readonly taskId:string;readonly importId:string;readonly sourceDigest:string;readonly ownedRevisions:ImportOwnedRevisions;readonly createdAt:string}
export interface StoredProjectImport {readonly artifact:ProjectImportDto;readonly rawCsv:string;readonly reconciliation:ProjectImportReconciliationDto|null}
export interface ProjectImportRepository {
 findImport(ws:string,id:string):Promise<StoredProjectImport|null>;
 insertImport(row:StoredProjectImport):Promise<void>;
 saveAppliedImport(row:StoredProjectImport):Promise<void>;
 findReferences(ws:string,namespace:string,ids:readonly string[]):Promise<ExternalImportReference[]>;
 insertReference(row:ExternalImportReference):Promise<void>;
 currentChangeSeq(ws:string):Promise<string>;
}
export interface ProjectImportReadScope {readonly context:CommandContext;readonly access:WorkspaceAccessRecord;readonly barrierAt:Date;readonly repository:PlanningRepository;readonly imports:ProjectImportRepository;readonly recurrenceCensus:Pick<RecurrenceScopedMaterializer,'assessPeriod'>}
export interface ProjectImportWriteScope extends PlanningWriteScope {readonly imports:ProjectImportRepository}
export interface ProjectImportUnitOfWork {run<T>(ctx:CommandContext,cap:Capability,work:(scope:ProjectImportWriteScope)=>Promise<T>):Promise<T>;read<T>(ctx:CommandContext,cap:Capability,work:(scope:ProjectImportReadScope)=>Promise<T>):Promise<T>}
export interface ProjectImportApplicationDependencies {readonly writer:ProjectImportUnitOfWork;readonly tools:Pick<PlanningTools,'digest'|'newId'>}
