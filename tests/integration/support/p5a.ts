import {projectImportResponseSchema,projectImportPreviewResponseSchema,projectImportAppliedResponseSchema,projectImportReconciliationResponseSchema,type ProjectImportDto,type ProjectImportMapping} from '@workloom/contracts';
import {expectEnvelope} from './p1a.js';
import {P4bClient} from './p4b.js';
import type {PlanningHarness} from './p2a-fixture.js';
export class P5aClient extends P4bClient {
 importPath(projectId:string,id?:string,action?:'preview'|'apply'|'reconciliation'){return `/projects/${projectId}/imports${id?`/${id}`:''}${action?`/${action}`:''}`;}
 async stage(projectId:string,csvText:string,sourceNamespace:string,key?:string){return expectEnvelope(await this.post(this.importPath(projectId),{fileName:'synthetic.csv',sourceNamespace,csvText},key),201,projectImportResponseSchema).data;}
 async staged(projectId:string,id:string){return expectEnvelope(await this.get(this.importPath(projectId,id)),200,projectImportResponseSchema).data;}
 async importPreview(projectId:string,staged:ProjectImportDto,mapping:ProjectImportMapping){return expectEnvelope(await this.post(this.importPath(projectId,staged.id,'preview'),{expectedImportRevision:staged.revision,mapping},null),200,projectImportPreviewResponseSchema).data;}
 async applyImport(projectId:string,staged:ProjectImportDto,mapping:ProjectImportMapping,previewHash:string,key?:string){return expectEnvelope(await this.post(this.importPath(projectId,staged.id,'apply'),{expectedImportRevision:staged.revision,mapping,previewHash},key),200,projectImportAppliedResponseSchema).data;}
 async reconciliation(projectId:string,id:string){return expectEnvelope(await this.get(this.importPath(projectId,id,'reconciliation')),200,projectImportReconciliationResponseSchema).data;}
}
export function p5aClients(h:PlanningHarness){const wrap=(c:PlanningHarness['owner'])=>new P5aClient(c.api,c.workspaceId);return {owner:wrap(h.owner),replica:wrap(h.replica),member:wrap(h.member),viewer:wrap(h.viewer),outsider:wrap(h.outsider)};}
