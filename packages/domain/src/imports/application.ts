import type {StageCsvImportInput,PreviewProjectImportInput,ApplyProjectImportInput,ProjectImportDto,ProjectImportPreviewDto,ProjectImportAppliedDto,ProjectImportReconciliationDto} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
export interface ProjectImportApplication {
 stageCsv(ctx:CommandContext,projectId:string,input:StageCsvImportInput):Promise<ProjectImportDto>;
 getImport(ctx:CommandContext,projectId:string,importId:string):Promise<ProjectImportDto>;
 previewImport(ctx:CommandContext,projectId:string,importId:string,input:PreviewProjectImportInput):Promise<ProjectImportPreviewDto>;
 applyImport(ctx:CommandContext,projectId:string,importId:string,input:ApplyProjectImportInput):Promise<ProjectImportAppliedDto>;
 getReconciliation(ctx:CommandContext,projectId:string,importId:string):Promise<ProjectImportReconciliationDto>;
}
