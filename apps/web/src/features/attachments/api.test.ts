import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../lib/api';
import type * as ApiModule from '../../lib/api';
import { attachmentPreviewUrl } from './api';

vi.mock('../../lib/api', async importOriginal => ({
  ...await importOriginal<typeof ApiModule>(), apiRequest: vi.fn(),
}));
const workspaceId = '10000000-0000-4000-8000-000000000001';
const taskId = '10000000-0000-4000-8000-000000000002';
const attachmentId = '10000000-0000-4000-8000-000000000003';
const preview = { attachmentId, kind: 'image', contentType: 'image/png', url: 'https://objects.example.test/private?signature=test', expiresAt: '2030-01-01T00:00:00.000Z' };
function response(overrides: Record<string, unknown> = {}) {
  return { status: 200, headers: new Headers(), payload: { data: { ...preview, ...overrides }, meta: { requestId: 'preview-test' } } };
}
beforeEach(() => { vi.resetAllMocks(); });

describe('attachment preview client boundary', () => {
  it('requests a currently authorized URL for the selected attachment and passes cancellation', async () => {
    vi.mocked(apiRequest).mockResolvedValue(response());
    const controller = new AbortController();
    expect(await attachmentPreviewUrl(workspaceId, taskId, attachmentId, controller.signal)).toEqual(preview);
    expect(apiRequest).toHaveBeenCalledWith(`/api/v1/workspaces/${workspaceId}/tasks/${taskId}/attachments/${attachmentId}/preview-url`,
      { method: 'POST', signal: controller.signal });
  });

  it.each([
    { attachmentId: taskId }, { kind: 'video', contentType: 'image/png' }, { contentType: 'image/svg+xml' },
    { url: 'javascript:alert(1)' }, { url: 'data:image/png;base64,invalid' },
    { url: 'http://objects.example.test/private' }, { url: 'https://user:secret@objects.example.test/private' },
  ])('rejects mismatched or unsafe preview data: %j', async overrides => {
    vi.mocked(apiRequest).mockResolvedValue(response(overrides));
    await expect(attachmentPreviewUrl(workspaceId, taskId, attachmentId)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('accepts local S3 emulators without allowing remote plain HTTP', async () => {
    vi.mocked(apiRequest).mockResolvedValue(response({ url: 'http://127.0.0.1:9000/preview' }));
    expect((await attachmentPreviewUrl(workspaceId, taskId, attachmentId)).url).toBe('http://127.0.0.1:9000/preview');
  });
});
