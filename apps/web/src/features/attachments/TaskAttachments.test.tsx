import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentFeature, TaskAttachmentDto, TaskAttachmentList } from '@workloom/contracts';
import { ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import * as api from './api';
import { TaskAttachments } from './TaskAttachments';

vi.mock('./api', () => ({ fetchAttachmentFeatures: vi.fn(), fetchAttachments: vi.fn(), fetchAttachment: vi.fn(), reserveAttachment: vi.fn(),
  removeAttachment: vi.fn(), uploadAttachment: vi.fn(), attachmentDownloadUrl: vi.fn(), attachmentPreviewUrl: vi.fn() }));
const props = { actorId: '10000000-0000-4000-8000-000000000001', workspaceId: '10000000-0000-4000-8000-000000000002', taskId: '10000000-0000-4000-8000-000000000003', writable: true };
const feature: AttachmentFeature = { enabled: true, reason: null, limits: { maxFilesPerTask: 5, maxFileSizeBytes: 50_000_000 }, uploadMode: 'api-stream', downloadMode: 'signed-url', downloadUrlTtlSeconds: 3600 };
const attachment: TaskAttachmentDto = { id: '10000000-0000-4000-8000-000000000004', workspaceId: props.workspaceId, taskId: props.taskId, uploadedByUserId: props.actorId,
  fileName: 'report.txt', sizeBytes: 3, state: 'ready', revision: 3, createdAt: new Date().toISOString(), uploadExpiresAt: new Date(Date.now() + 60_000).toISOString() };
let list: TaskAttachmentList;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.mocked(api.attachmentPreviewUrl).mockResolvedValue({ attachmentId: attachment.id, kind: 'image', contentType: 'image/png',
    url: 'https://objects.example.test/photo?signature=test', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  list = { items: [], remainingSlots: 5, canUpload: true, canDelete: true };
  vi.mocked(api.fetchAttachmentFeatures).mockResolvedValue(feature);
  vi.mocked(api.fetchAttachments).mockImplementation(async () => list);
  vi.mocked(api.reserveAttachment).mockResolvedValue({ ...attachment, state: 'pending', revision: 1 });
  vi.mocked(api.fetchAttachment).mockResolvedValue(attachment);
  vi.mocked(api.uploadAttachment).mockImplementation(async () => { list = { ...list, items: [attachment], remainingSlots: 4 }; return attachment; });
  vi.mocked(api.removeAttachment).mockImplementation(async () => { list = { ...list, items: [], remainingSlots: 5 }; return { ...attachment, state: 'deleted' }; });
});
function mount(strict = false, writable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const panel = <TaskAttachments {...props} writable={writable} />;
  const result = render(<QueryClientProvider client={client}>{strict ? <StrictMode>{panel}</StrictMode> : panel}</QueryClientProvider>);
  const input = result.container.querySelector('input[type=file]');
  if (!input) throw new Error('File selector missing.');
  return { ...result, client, input, user: userEvent.setup() };
}
describe('task attachments', () => {
  it('keeps the attach button disabled with a server-configuration explanation when S3 is absent', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'photo.png' }] };
    vi.mocked(api.fetchAttachmentFeatures).mockResolvedValue({ ...feature, enabled: false, reason: 'storage_not_configured' });
    mount();
    expect(await screen.findByText('Configure file storage on the server to attach files.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeDisabled();
    expect(api.reserveAttachment).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Preview photo.png' })).toBeDisabled();
    expect(api.attachmentPreviewUrl).not.toHaveBeenCalled();
  });

  it('uploads through the API and refreshes the ready list with download and remove controls', async () => {
    const { input } = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    const file = new File(['abc'], 'report.txt');
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole('button', { name: 'Download report.txt' })).toBeEnabled();
    expect(api.reserveAttachment).toHaveBeenCalledWith(props.workspaceId, props.taskId, props.actorId, file, expect.any(String), expect.any(AbortSignal));
    expect(api.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('rejects too many files and oversize files before reserving a server slot', async () => {
    const { input } = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.change(input, { target: { files: Array.from({ length: 6 }, (_, i) => new File(['a'], `${i}.txt`)) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 5');
    const large = new File(['a'], 'large.txt'); Object.defineProperty(large, 'size', { value: 50_000_001 });
    fireEvent.change(input, { target: { files: [large] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('50 MB');
    expect(api.reserveAttachment).not.toHaveBeenCalled();
  });

  it('recovers a lost reserve response with the same idempotency key and skips a completed upload', async () => {
    vi.mocked(api.reserveAttachment).mockRejectedValueOnce(new ApiError({ kind: 'network', status: null })).mockResolvedValueOnce(attachment);
    const { input, user } = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.change(input, { target: { files: [new File(['abc'], 'report.txt')] } });
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.reserveAttachment).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.reserveAttachment).mock.calls;
    expect(calls[0]?.[4]).toBe(calls[1]?.[4]);
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  it('aborts the active upload when changing tasks or closing the task pane', async () => {
    let uploadSignal: AbortSignal | undefined;
    vi.mocked(api.uploadAttachment).mockImplementation(async (_w, _t, _a, _r, _f, signal) => {
      uploadSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const { input, unmount } = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.change(input, { target: { files: [new File(['abc'], 'report.txt')] } });
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
    unmount();
    expect(uploadSignal?.aborted).toBe(true);
  });

  it('refreshes actor-scoped task counts after an upload and removal without a page reload', async () => {
    const { client, input, user } = mount();
    const queryKey = queryKeys.taskList(props.actorId, props.workspaceId, 'project', {});
    const readCount = vi.fn(async () => list.items.filter(row => row.state === 'ready').length);
    const observer = new QueryObserver(client, { queryKey, queryFn: readCount, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => undefined);
    const otherActorKey = queryKeys.taskList('another-user', props.workspaceId, 'project', {});
    client.setQueryData(otherActorKey, 3);
    try {
      await waitFor(() => expect(observer.getCurrentResult().data).toBe(0));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
      fireEvent.change(input, { target: { files: [new File(['abc'], 'report.txt')] } });
      await waitFor(() => expect(observer.getCurrentResult().data).toBe(1));
      await user.click(await screen.findByRole('button', { name: 'Remove report.txt' }));
      await waitFor(() => expect(observer.getCurrentResult().data).toBe(0));
      expect(readCount).toHaveBeenCalledTimes(3);
      expect(client.getQueryState(otherActorKey)?.isInvalidated).toBe(false);
    } finally { unsubscribe(); }
  });

  it('opens an image inside a modal on demand and returns focus when Escape closes it', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'photo.png' }] };
    const { user } = mount();
    const opener = await screen.findByRole('button', { name: 'photo.png' });
    expect(api.attachmentPreviewUrl).not.toHaveBeenCalled();
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'photo.png' });
    const img = await within(dialog).findByRole('img', { name: 'photo.png' });
    expect(img).toHaveAttribute('src', 'https://objects.example.test/photo?signature=test');
    fireEvent.load(img);
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download file' })).toBeEnabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('allows preview for readers without enabling attachment edits', async () => {
    list = { ...list, canUpload: false, canDelete: false, items: [{ ...attachment, fileName: 'photo.png' }] };
    const { user } = mount(false, false);
    await user.click(await screen.findByRole('button', { name: 'Preview photo.png' }));
    expect(await screen.findByRole('img', { name: 'photo.png' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Remove photo.png' })).not.toBeInTheDocument();
    expect(api.reserveAttachment).not.toHaveBeenCalled();
    expect(api.removeAttachment).not.toHaveBeenCalled();
  });

  it('shows native video controls without autoplay and releases playback on close', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'clip.webm' }] };
    vi.mocked(api.attachmentPreviewUrl).mockResolvedValue({ attachmentId: attachment.id, kind: 'video', contentType: 'video/webm',
      url: 'https://objects.example.test/clip', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const { user } = mount(true);
    await user.click(await screen.findByRole('button', { name: 'Preview clip.webm' }));
    const video = await screen.findByLabelText('clip.webm', { selector: 'video' });
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', 'https://objects.example.test/clip');
    expect(video).not.toHaveAttribute('autoplay');
    fireEvent.loadedMetadata(video);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(video).not.toHaveAttribute('src');
  });

  it('offers a new authorized request after decoding fails and keeps download available', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'photo.png' }] };
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Preview photo.png' }));
    fireEvent.error(await screen.findByRole('img', { name: 'photo.png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This browser cannot display the file');
    expect(screen.getByRole('button', { name: 'Download file' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('img', { name: 'photo.png' })).toBeInTheDocument();
    expect(api.attachmentPreviewUrl).toHaveBeenCalledTimes(2);
  });

  it('discards pending preview URLs after closing and surfaces authorization errors on reopen', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'photo.png' }] };
    let finish: ((value: Awaited<ReturnType<typeof api.attachmentPreviewUrl>>) => void) | undefined;
    vi.mocked(api.attachmentPreviewUrl).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Preview photo.png' }));
    const signal = vi.mocked(api.attachmentPreviewUrl).mock.calls[0]?.[3];
    await user.keyboard('{Escape}');
    expect(signal?.aborted).toBe(true);
    await act(async () => finish?.({ attachmentId: attachment.id, kind: 'image', contentType: 'image/png',
      url: 'https://objects.example.test/stale', expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    vi.mocked(api.attachmentPreviewUrl).mockRejectedValueOnce(new ApiError({ kind: 'forbidden', status: 403 }));
    await user.click(screen.getByRole('button', { name: 'Preview photo.png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your access has changed');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('closes an open preview when the current task access is revoked', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'photo.png' }] };
    const { user, client } = mount();
    await user.click(await screen.findByRole('button', { name: 'Preview photo.png' }));
    expect(await screen.findByRole('img', { name: 'photo.png' })).toBeInTheDocument();
    vi.mocked(api.fetchAttachments).mockRejectedValue(new ApiError({ kind: 'forbidden', status: 403 }));
    await act(async () => { await client.invalidateQueries({ queryKey: ['attachments'] }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps active-content files and unfinished uploads out of the preview flow', async () => {
    list = { ...list, items: [{ ...attachment, fileName: 'image.svg' }, { ...attachment, id: props.actorId, fileName: 'waiting.png', state: 'uploading' }] };
    mount();
    await screen.findByText('image.svg');
    expect(screen.queryByRole('button', { name: /^Preview/ })).not.toBeInTheDocument();
    expect(api.attachmentPreviewUrl).not.toHaveBeenCalled();
  });

  it('hides stale file names and disables uploads when access is revoked during refetch', async () => {
    list = { ...list, items: [attachment], remainingSlots: 4 };
    const { client } = mount();
    expect(await screen.findByText('report.txt')).toBeInTheDocument();
    vi.mocked(api.fetchAttachments).mockRejectedValue(new ApiError({ kind: 'forbidden', status: 403 }));
    await act(async () => { await client.invalidateQueries({ queryKey: ['attachments'] }); });
    await waitFor(() => expect(screen.queryByText('report.txt')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeDisabled();
  });
});
