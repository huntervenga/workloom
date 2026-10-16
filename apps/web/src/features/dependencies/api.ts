import {
  createTaskDependencyInputSchema, updateTaskDependencyInputSchema, updateDependencyPolicyInputSchema, setGraphLayoutInputSchema,
  taskDependencyListQuerySchema, taskBlockingQuerySchema, dependencyGraphInputSchema,
  taskDependencyResponseSchema, taskDependencyListResponseSchema, taskBlockingResponseSchema,
  projectDependencyPolicyResponseSchema, dependencyGraphResponseSchema, graphLayoutResponseSchema,
  type CreateTaskDependencyInput, type UpdateTaskDependencyInput, type UpdateDependencyPolicyInput, type SetGraphLayoutInput,
  type TaskDependencyListQuery, type TaskBlockingQuery, type DependencyGraphQuery,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation, type ResponseParser } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

const part = encodeURIComponent;
const root = (w: string) => workspacePath(w);
const project = (w: string, p: string) => `${root(w)}/projects/${part(p)}`;
function query(schema: ResponseParser<object>, input: object) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}
export async function fetchDependencyPage(w: string, input: TaskDependencyListQuery, signal?: AbortSignal) {
  return apiGet(`${root(w)}/dependencies?${query(taskDependencyListQuerySchema, input)}`, taskDependencyListResponseSchema, signal);
}
export async function fetchTaskBlocking(w: string, taskId: string, input: TaskBlockingQuery, signal?: AbortSignal) {
  const result = await apiGet(`${root(w)}/tasks/${part(taskId)}/blocking?${query(taskBlockingQuerySchema, input)}`, taskBlockingResponseSchema, signal);
  if (result.data.summary.taskId !== taskId.toLowerCase() || result.data.blockers.some(row => row.predecessor.projectId !== row.predecessorContext.project.id || row.predecessor.statusId !== row.predecessorContext.status.id)) throw new ApiError({ kind: 'invalid_response', status: 200 });
  return result;
}
export async function fetchDependencyGraph(w: string, p: string, input: DependencyGraphQuery, signal?: AbortSignal) {
  const parsed = dependencyGraphInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams({ rootTaskIds: parsed.data.rootTaskIds.join(','), neighborDepth: String(parsed.data.neighborDepth) });
  const result = await apiGet(`${project(w, p)}/graph?${params}`, dependencyGraphResponseSchema, signal);
  if (result.data.projectId !== p.toLowerCase() || result.data.nodes.some(row => row.task.projectId !== row.context.project.id || row.task.statusId !== row.context.status.id)) throw new ApiError({ kind: 'invalid_response', status: 200 });
  return result.data;
}
export async function fetchDependencyPolicy(w: string, p: string, signal?: AbortSignal) {
  return (await apiGet(`${project(w, p)}/dependency-policy`, projectDependencyPolicyResponseSchema, signal)).data;
}
export async function fetchGraphLayout(w: string, p: string, signal?: AbortSignal) {
  return (await apiGet(`${project(w, p)}/graph-layout`, graphLayoutResponseSchema, signal)).data;
}
export const createDependencyRequest = (w: string, input: CreateTaskDependencyInput) => prepareMutation({ path: `${root(w)}/dependencies`, method: 'POST', inputSchema: createTaskDependencyInputSchema, input, responseSchema: taskDependencyResponseSchema });
export const updateDependencyRequest = (w: string, id: string, input: UpdateTaskDependencyInput) => prepareMutation({ path: `${root(w)}/dependencies/${part(id)}`, method: 'PATCH', inputSchema: updateTaskDependencyInputSchema, input, responseSchema: taskDependencyResponseSchema });
export const updatePolicyRequest = (w: string, p: string, input: UpdateDependencyPolicyInput) => prepareMutation({ path: `${project(w, p)}/dependency-policy`, method: 'PATCH', inputSchema: updateDependencyPolicyInputSchema, input, responseSchema: projectDependencyPolicyResponseSchema });
export const setLayoutRequest = (w: string, p: string, input: SetGraphLayoutInput) => prepareMutation({ path: `${project(w, p)}/graph-layout`, method: 'PUT', inputSchema: setGraphLayoutInputSchema, input, responseSchema: graphLayoutResponseSchema });
