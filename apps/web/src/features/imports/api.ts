import {
  stageCsvImportInputSchema, previewProjectImportInputSchema, applyProjectImportInputSchema,
  projectImportResponseSchema, projectImportPreviewResponseSchema, projectImportAppliedResponseSchema, projectImportReconciliationResponseSchema,
  type StageCsvImportInput, type PreviewProjectImportInput, type ApplyProjectImportInput,
} from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
export const importPath = (w: string, p: string, id?: string) => `${workspacePath(w)}/projects/${encodeURIComponent(p)}/imports${id ? `/${encodeURIComponent(id)}` : ''}`;
export async function fetchProjectImport(w: string, p: string, id: string, signal?: AbortSignal) {
  const result = (await apiGet(importPath(w, p, id), projectImportResponseSchema, signal)).data;
  if (result.id !== id || result.workspaceId !== w || result.projectId !== p) throw new ApiError({ kind: 'invalid_response', status: 200 });
  return result;
}
export async function fetchImportReconciliation(w: string, p: string, id: string, signal?: AbortSignal) {
  const result = (await apiGet(`${importPath(w, p, id)}/reconciliation`, projectImportReconciliationResponseSchema, signal)).data;
  if (result.importId !== id || result.projectId !== p) throw new ApiError({ kind: 'invalid_response', status: 200 });
  return result;
}
export async function previewProjectImport(w: string, p: string, id: string, input: PreviewProjectImportInput) {
  const parsed = previewProjectImportInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(`${importPath(w, p, id)}/preview`, { method: 'POST', body: parsed.data });
  const result = projectImportPreviewResponseSchema.safeParse(response.payload);
  if (!result.success || result.data.data.importId !== id || result.data.data.projectId !== p || result.data.data.importRevision !== parsed.data.expectedImportRevision) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return result.data.data;
}
export const stageImportRequest = (w: string, p: string, input: StageCsvImportInput) => prepareMutation({ path: importPath(w, p), method: 'POST', input, inputSchema: stageCsvImportInputSchema, responseSchema: projectImportResponseSchema.refine(result => result.data.workspaceId === w && result.data.projectId === p && result.data.fileName === input.fileName && result.data.sourceNamespace === input.sourceNamespace) });
export const applyImportRequest = (w: string, p: string, id: string, input: ApplyProjectImportInput) => prepareMutation({ path: `${importPath(w, p, id)}/apply`, method: 'POST', input, inputSchema: applyProjectImportInputSchema, responseSchema: projectImportAppliedResponseSchema.refine(result => result.data.import.id === id && result.data.import.workspaceId === w && result.data.import.projectId === p && result.data.reconciliation.importId === id && result.data.reconciliation.projectId === p && result.data.reconciliation.status === 'applied') });
