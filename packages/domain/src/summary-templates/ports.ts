import type * as C from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {PlanningCheckScope} from '../planning-checks/ports.js';
export interface SummaryTemplateRepository {
 list(projectId:string):Promise<C.SummaryTemplateDefinitionDto[]>;
 bindings(projectId:string):Promise<C.SummaryTemplateBindingDto[]>;
 saveTemplate(value:C.SummaryTemplateDefinitionDto,actorUserId:string,at:string):Promise<void>;
 saveBinding(value:C.SummaryTemplateBindingDto,actorUserId:string,at:string):Promise<void>;
}
export interface SummaryTemplateScope extends PlanningCheckScope {templates:SummaryTemplateRepository}
export interface SummaryTemplateDependencies {read<T>(context:CommandContext,capability:Capability,work:(scope:SummaryTemplateScope)=>Promise<T>):Promise<T>;write<T>(context:CommandContext,capability:Capability,work:(scope:SummaryTemplateScope)=>Promise<T>):Promise<T>;newId():string;digest(value:string):string}
export interface SummaryTemplateApplication {
 catalog(ctx:CommandContext,projectId:string):Promise<C.SummaryTemplateCatalogDto>;
 create(ctx:CommandContext,projectId:string,input:C.CreateSummaryTemplateInput):Promise<C.SummaryTemplateCatalogDto>;
 update(ctx:CommandContext,projectId:string,templateId:string,input:C.UpdateSummaryTemplateInput):Promise<C.SummaryTemplateCatalogDto>;
 bind(ctx:CommandContext,projectId:string,input:C.BindSummaryTemplateInput):Promise<C.SummaryTemplateCatalogDto>;
 customize(ctx:CommandContext,projectId:string,bindingId:string,input:C.CustomizeSummaryTemplateInput):Promise<C.SummaryTemplateCatalogDto>;
 reset(ctx:CommandContext,projectId:string,bindingId:string,input:C.ResetSummaryTemplateInput):Promise<C.SummaryTemplateCatalogDto>;
 detach(ctx:CommandContext,projectId:string,bindingId:string,input:C.ResetSummaryTemplateInput):Promise<C.SummaryTemplateCatalogDto>;
}
