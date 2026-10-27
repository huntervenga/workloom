import { attachmentDownloadResponseSchema, attachmentPreviewResponseSchema, errorResponseSchema, serverFeaturesResponseSchema, taskAttachmentResponseSchema, taskAttachmentsResponseSchema, type TaskAttachmentDto } from '@workloom/contracts';
import { ApiError, apiGet, apiRequest } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export const attachmentPath = (workspaceId: string, taskId: string) => `${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}/attachments`;
export const fetchAttachmentFeatures = async (signal?: AbortSignal) => (await apiGet('/api/v1/features', serverFeaturesResponseSchema, signal)).data.features.taskAttachments;
export const fetchAttachments = async (workspaceId: string, taskId: string, signal?: AbortSignal) =>
  (await apiGet(attachmentPath(workspaceId, taskId), taskAttachmentsResponseSchema.refine(result => result.data.items.every(row => row.workspaceId === workspaceId && row.taskId === taskId)), signal)).data;
export const fetchAttachment = async (workspaceId: string, taskId: string, id: string) =>
  (await apiGet(`${attachmentPath(workspaceId, taskId)}/${id}`, taskAttachmentResponseSchema.refine(result => result.data.id === id && result.data.taskId === taskId && result.data.workspaceId === workspaceId))).data;

async function writeAttachment(workspaceId: string, taskId: string, path: string, method: 'POST' | 'DELETE', body: unknown, key: string, signal?: AbortSignal) {
  const response = await apiRequest(path, { method, body, headers: { 'Idempotency-Key': key }, signal });
  const parsed = taskAttachmentResponseSchema.safeParse(response.payload);
  if (!parsed.success || parsed.data.data.workspaceId !== workspaceId || parsed.data.data.taskId !== taskId) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return parsed.data.data;
}
export const reserveAttachment = (workspaceId: string, taskId: string, actorId: string, file: File, key: string, signal?: AbortSignal) =>
  writeAttachment(workspaceId, taskId, attachmentPath(workspaceId, taskId), 'POST', { fileName: file.name, sizeBytes: file.size, expectedActorId: actorId }, key, signal);
export const removeAttachment = (workspaceId: string, taskId: string, actorId: string, row: TaskAttachmentDto, key: string) =>
  writeAttachment(workspaceId, taskId, `${attachmentPath(workspaceId, taskId)}/${row.id}`, 'DELETE', { expectedRevision: row.revision, expectedActorId: actorId }, key);
export async function attachmentDownloadUrl(workspaceId: string, taskId: string, id: string) {
  const response = await apiRequest(`${attachmentPath(workspaceId, taskId)}/${id}/download-url`, { method: 'POST' });
  const parsed = attachmentDownloadResponseSchema.safeParse(response.payload);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_response', status: response.status });
  validateSignedUrl(parsed.data.data.url, response.status);
  return parsed.data.data;
}
export async function attachmentPreviewUrl(workspaceId: string, taskId: string, id: string, signal?: AbortSignal) {
  const response = await apiRequest(`${attachmentPath(workspaceId, taskId)}/${id}/preview-url`, { method: 'POST', signal });
  const parsed = attachmentPreviewResponseSchema.safeParse(response.payload);
  if (!parsed.success || parsed.data.data.attachmentId !== id) throw new ApiError({ kind: 'invalid_response', status: response.status });
  validateSignedUrl(parsed.data.data.url, response.status);
  return parsed.data.data;
}
function validateSignedUrl(value: string, status: number) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new ApiError({ kind: 'invalid_response', status });
  }
}

/** XHR exposes upload progress without reading the Blob into memory or bypassing our API. */
export function uploadAttachment(workspaceId: string, taskId: string, actorId: string, row: TaskAttachmentDto, file: File, signal: AbortSignal, progress: (value: number) => void): Promise<TaskAttachmentDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const clean = () => signal.removeEventListener('abort', abort);
    xhr.open('PUT', `${attachmentPath(workspaceId, taskId)}/${row.id}/content`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Workloom-Expected-Actor', actorId);
    xhr.responseType = 'json';
    xhr.timeout = 15 * 60_000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      clean();
      const parsed = taskAttachmentResponseSchema.safeParse(xhr.response);
      if (xhr.status >= 200 && xhr.status < 300 && parsed.success && parsed.data.data.id === row.id && parsed.data.data.taskId === taskId && parsed.data.data.workspaceId === workspaceId) { resolve(parsed.data.data); return; }
      const error = errorResponseSchema.safeParse(xhr.response);
      reject(new ApiError({ kind: xhr.status === 401 ? 'unauthenticated' : xhr.status === 403 ? 'forbidden' : xhr.status === 409 ? 'conflict' : xhr.status >= 500 ? 'unavailable' : 'validation', status: xhr.status,
        code: error.success && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.data.error.code) ? error.data.error.code : null }));
    };
    xhr.onerror = xhr.ontimeout = () => { clean(); reject(new ApiError({ kind: 'network', status: null })); };
    xhr.onabort = () => { clean(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { clean(); reject(new DOMException('Aborted', 'AbortError')); return; }
    xhr.send(file);
  });
}
