import type {
  TaskFieldPolicyDto, TaskFieldPolicyStateDto, SetTaskFieldPolicyInput, SetTaskFieldValueExceptionInput,
  CreateTaskFieldInput,
  CreateTaskFieldOptionInput,
  ProjectColumnsDto,
  SetTaskFieldValueInput,
  TaskFieldBatchQuery,
  TaskFieldDefinitionDto,
  TaskFieldHistoryQuery,
  TaskFieldValueDto,
  TaskFieldValueHistoryDto,
  UpdateProjectColumnsInput,
  UpdateTaskFieldInput,
  UpdateTaskFieldOptionInput,
} from '@workloom/contracts';

import type { CommandContext } from '../access/context.js';

/**
 * One page of value history. The HTTP adapter maps `items` to `data` and
 * `nextCursor` to `meta.nextCursor`; `null` means the last page.
 */
export interface TaskFieldHistoryPage {
  readonly items: TaskFieldValueHistoryDto[];
  readonly nextCursor: string | null;
}

/**
 * P1b custom task fields, shared project column settings and typed values, shared by HTTP, MCP,
 * imports and jobs. See `@workloom/contracts` `fields.ts` for the route catalog and error mapping.
 *
 * - `context` is trusted and built by a server adapter; the workspace and actor come from it,
 *   never from an input. Every mutation requires `context.idempotencyKey`.
 * - Inputs are expected to be parsed with the matching contracts schema. The application still
 *   re-checks capabilities (`fields.manage` for definitions, options and columns), project scope,
 *   type/option compatibility, option and membership references, locks and every revision guard.
 * - Values are independent of the task revision, its work package and participants. History is
 *   written only for changed values while the field has `historyEnabled`.
 * - History cursors are bound to actor, workspace, permission epoch, task and field and signed
 *   with a process secret; a cursor that fails those checks is rejected.
 */
export interface TaskFieldApplication {
  getPolicy(context:CommandContext,fieldId:string):Promise<TaskFieldPolicyDto>;
  setPolicy(context:CommandContext,fieldId:string,input:SetTaskFieldPolicyInput):Promise<TaskFieldPolicyDto>;
  getPolicyState(context:CommandContext,taskId:string,fieldId:string):Promise<TaskFieldPolicyStateDto>;
  setTaskValueException(context:CommandContext,taskId:string,fieldId:string,input:SetTaskFieldValueExceptionInput):Promise<TaskFieldValueDto>;
  listFields(context: CommandContext, projectId: string): Promise<TaskFieldDefinitionDto[]>;
  createField(context: CommandContext, input: CreateTaskFieldInput): Promise<TaskFieldDefinitionDto>;
  updateField(context: CommandContext, fieldId: string, input: UpdateTaskFieldInput): Promise<TaskFieldDefinitionDto>;
  createOption(
    context: CommandContext,
    fieldId: string,
    input: CreateTaskFieldOptionInput,
  ): Promise<TaskFieldDefinitionDto>;
  updateOption(
    context: CommandContext,
    fieldId: string,
    optionId: string,
    input: UpdateTaskFieldOptionInput,
  ): Promise<TaskFieldDefinitionDto>;

  getProjectColumns(context: CommandContext, projectId: string): Promise<ProjectColumnsDto>;
  updateProjectColumns(
    context: CommandContext,
    projectId: string,
    input: UpdateProjectColumnsInput,
  ): Promise<ProjectColumnsDto>;

  listTaskValues(context: CommandContext, taskId: string): Promise<TaskFieldValueDto[]>;
  listProjectValues(
    context: CommandContext,
    projectId: string,
    input: TaskFieldBatchQuery,
  ): Promise<TaskFieldValueDto[]>;
  setTaskValue(
    context: CommandContext,
    taskId: string,
    fieldId: string,
    input: SetTaskFieldValueInput,
  ): Promise<TaskFieldValueDto>;
  listValueHistory(
    context: CommandContext,
    taskId: string,
    fieldId: string,
    input: TaskFieldHistoryQuery,
  ): Promise<TaskFieldHistoryPage>;
}
