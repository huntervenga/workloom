import { ApiError, apiGet, apiRequest, isRecord, type ResponseParser } from '../../lib/api';
import { isUuid } from '../../lib/format';

export const MAX_ASANA_FILE_BYTES = 10 * 1024 * 1024;
export interface AsanaPreview {
  projectName: string;
  tasks: number; roots: number; subtasks: number; sections: number;
  createTasks: number; reuseTasks: number; completed: number;
  fields: { name: string; type: string }[];
  warnings: string[];
  existingProjectId?: string;
}
export interface AsanaUpload { uploadId: string; preview: AsanaPreview }
export interface AsanaImportResult {
  projectId: string; reportId: string | null; taskCount: number; createdTasks: number; reusedTasks: number;
}
export interface PreviewInput {
  jsonBase64: string; csvBase64: string;
  preserveMilestones: boolean; preserveExternalDependencies: boolean;
}
export const asanaImportPath = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dev/asana-import`;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 20_000;
function preview(value: unknown): value is AsanaPreview {
  return isRecord(value) && text(value['projectName']) &&
    ['tasks', 'roots', 'subtasks', 'sections', 'createTasks', 'reuseTasks', 'completed'].every(key => count(value[key])) &&
    Array.isArray(value['fields']) && value['fields'].length <= 1000 && value['fields'].every(field => isRecord(field) && text(field['name']) && text(field['type'])) &&
    Array.isArray(value['warnings']) && value['warnings'].length <= 1000 && value['warnings'].every(text) &&
    (value['existingProjectId'] === undefined || typeof value['existingProjectId'] === 'string' && isUuid(value['existingProjectId']));
}
function envelope<T>(guard: (value: unknown) => value is T): ResponseParser<{ data: T }> {
  return { safeParse(value) {
    if (!isRecord(value) || !guard(value['data'])) return { success: false };
    return { success: true, data: { data: value['data'] } };
  } };
}
const capabilitySchema = envelope((value): value is { enabled: boolean } => isRecord(value) && typeof value['enabled'] === 'boolean');
const previewSchema = envelope((value): value is AsanaUpload => isRecord(value) && typeof value['uploadId'] === 'string' && isUuid(value['uploadId']) && preview(value['preview']));
const resultSchema = envelope((value): value is AsanaImportResult => isRecord(value) && typeof value['projectId'] === 'string' && isUuid(value['projectId']) && (value['reportId'] === null || typeof value['reportId'] === 'string' && isUuid(value['reportId'])) && ['taskCount', 'createdTasks', 'reusedTasks'].every(key => count(value[key])));

export async function fetchAsanaImportCapability(workspaceId: string, signal?: AbortSignal) {
  return (await apiGet(asanaImportPath(workspaceId), capabilitySchema, signal)).data.enabled;
}

/** Read the original bytes, including UTF-8 BOMs; never decode and re-encode an export. */
export async function fileBase64(file: File): Promise<string> {
  if (file.size > MAX_ASANA_FILE_BYTES) throw new ApiError({ kind: 'invalid_input', status: null });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function post<T>(path: string, body: unknown, actorId: string, idempotencyKey: string, parser: ResponseParser<{ data: T }>): Promise<T> {
  if (!isUuid(actorId) || !isUuid(idempotencyKey)) throw new ApiError({ kind: 'invalid_input', status: null });
  const { status, payload } = await apiRequest(path, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey, 'X-Workloom-Actor-ID': actorId } });
  const parsed = parser.safeParse(payload);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_response', status });
  return parsed.data.data;
}
export function previewAsanaImport(workspaceId: string, actorId: string, input: PreviewInput, key: string) {
  return post(`${asanaImportPath(workspaceId)}/preview`, input, actorId, key, previewSchema);
}
export function applyAsanaImport(workspaceId: string, actorId: string, uploadId: string, key: string) {
  if (!isUuid(uploadId)) throw new ApiError({ kind: 'invalid_input', status: null });
  return post(`${asanaImportPath(workspaceId)}/${encodeURIComponent(uploadId)}/apply`, {}, actorId, key, resultSchema);
}
