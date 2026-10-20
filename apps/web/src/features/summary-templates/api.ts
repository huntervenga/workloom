import { summaryTemplateCatalogResponseSchema, createSummaryTemplateInputSchema, updateSummaryTemplateInputSchema, bindSummaryTemplateInputSchema, customizeSummaryTemplateInputSchema, resetSummaryTemplateInputSchema, type CreateSummaryTemplateInput, type UpdateSummaryTemplateInput, type BindSummaryTemplateInput, type CustomizeSummaryTemplateInput, type ResetSummaryTemplateInput } from '@workloom/contracts';
import { apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
const projectPath=(workspace:string,project:string)=>`${workspacePath(workspace)}/projects/${encodeURIComponent(project)}`;
export async function fetchSummaryTemplates(workspace:string,project:string,signal?:AbortSignal){return(await apiGet(`${projectPath(workspace,project)}/summary-templates`,summaryTemplateCatalogResponseSchema,signal)).data;}
export type SummaryTemplateAction = {kind:'create';input:CreateSummaryTemplateInput}|{kind:'update';id:string;input:UpdateSummaryTemplateInput}|{kind:'bind';input:BindSummaryTemplateInput}|{kind:'customize';id:string;input:CustomizeSummaryTemplateInput}|{kind:'reset'|'detach';id:string;input:ResetSummaryTemplateInput};
export function summaryTemplateRequest(workspace:string,project:string,action:SummaryTemplateAction){
 const base=projectPath(workspace,project),responseSchema=summaryTemplateCatalogResponseSchema;
 switch(action.kind){
 case 'create':return prepareMutation({method:'POST',path:`${base}/summary-templates`,input:action.input,inputSchema:createSummaryTemplateInputSchema,responseSchema});
 case 'update':return prepareMutation({method:'PATCH',path:`${base}/summary-templates/${encodeURIComponent(action.id)}`,input:action.input,inputSchema:updateSummaryTemplateInputSchema,responseSchema});
 case 'bind':return prepareMutation({method:'PUT',path:`${base}/summary-template-bindings`,input:action.input,inputSchema:bindSummaryTemplateInputSchema,responseSchema});
 case 'customize':return prepareMutation({method:'PATCH',path:`${base}/summary-template-bindings/${encodeURIComponent(action.id)}`,input:action.input,inputSchema:customizeSummaryTemplateInputSchema,responseSchema});
 case 'reset':case 'detach':return prepareMutation({method:'POST',path:`${base}/summary-template-bindings/${encodeURIComponent(action.id)}/${action.kind}`,input:action.input,inputSchema:resetSummaryTemplateInputSchema,responseSchema});
 }
}
