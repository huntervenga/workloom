import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attachmentMedia, attachmentNameSchema, MAX_TASK_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type MembershipDto, type TaskAttachmentDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { Download, Eye, Paperclip, Trash2 } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import { attachmentDownloadUrl, fetchAttachment, fetchAttachmentFeatures, fetchAttachments, removeAttachment, reserveAttachment, uploadAttachment } from './api';

interface Props { actorId: string; workspaceId: string; taskId: string; writable: boolean; members?: readonly MembershipDto[] }
interface Draft { file: File; key: string; row?: TaskAttachmentDto; controller: AbortController; cancelled: boolean; progress: number; phase: 'queued' | 'uploading' | 'error' | 'done'; }
const keys = (props: Props) => ['attachments', props.actorId, props.workspaceId, props.taskId] as const;

/** Changing account or task unmounts all local drafts and cancels their byte streams. */
export function TaskAttachments(props: Props) {
  return <AttachmentPanel key={`${props.actorId}:${props.workspaceId}:${props.taskId}`} {...props} />;
}
function AttachmentPanel(props: Props) {
  const { actorId, workspaceId, taskId, writable } = props;
  const { t, formatDate, formatNumber } = useTranslation(), client = useQueryClient();
  const errorLabels = { limit: t('attachments.limit'), tooLarge: t('attachments.tooLarge'), accessChanged: t('attachments.accessChanged'),
    changed: t('attachments.changed'), failed: t('attachments.failed'), invalidName: t('attachments.invalidName') };
  const input = useRef<HTMLInputElement>(null), alive = useRef(true), drafts = useRef<Draft[]>([]), sending = useRef(false);
  const [, setRender] = useState(0), [error, setProblemKind] = useState<keyof typeof errorLabels | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const features = useQuery({ queryKey: ['server-features', actorId], queryFn: ({ signal }) => fetchAttachmentFeatures(signal), staleTime: 60_000, retry: false });
  const list = useQuery({ queryKey: keys(props), queryFn: ({ signal }) => fetchAttachments(workspaceId, taskId, signal), retry: false,
    refetchInterval: query => query.state.data?.items.some(row => row.state !== 'ready') ? 5000 : false });
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const draft of drafts.current) draft.controller.abort(); }; }, []);
  const redraw = () => { if (alive.current) setRender(value => value + 1); };
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: keys(props) }),
    // Project lists, linked rows, My Tasks and task details share this actor/workspace prefix.
    client.invalidateQueries({ queryKey: queryKeys.tasks(actorId, workspaceId) }),
  ]);
  const report = (caught: unknown) => {
    if (!alive.current) return;
    setProblemKind(caught instanceof ApiError && caught.code === 'ATTACHMENT_LIMIT_REACHED' ? 'limit'
      : caught instanceof ApiError && caught.status === 413 ? 'tooLarge'
      : caught instanceof ApiError && ['unauthenticated', 'forbidden', 'not_found'].includes(caught.kind) ? 'accessChanged'
      : caught instanceof ApiError && caught.status === 409 ? 'changed' : 'failed');
  };
  const cancelServer = async (draft: Draft) => {
    if (!draft.row) return;
    const current = await fetchAttachment(workspaceId, taskId, draft.row.id);
    if (current.state !== 'deleted') await removeAttachment(workspaceId, taskId, actorId, current, crypto.randomUUID());
  };
  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      for (const draft of drafts.current) {
        if (draft.phase !== 'queued' || draft.cancelled || !alive.current) continue;
        draft.phase = 'uploading'; redraw();
        try {
          // Exact reserve replay recovers a lost response without reserving another slot.
          draft.row = await reserveAttachment(workspaceId, taskId, actorId, draft.file, draft.key, draft.controller.signal);
          if (draft.cancelled) { await cancelServer(draft); continue; }
          if (['failed', 'expired', 'deleted'].includes(draft.row.state)) {
            draft.key = crypto.randomUUID();
            draft.row = await reserveAttachment(workspaceId, taskId, actorId, draft.file, draft.key, draft.controller.signal);
          }
          if (draft.row.state === 'uploading') throw new ApiError({ kind: 'conflict', status: 409 });
          if (draft.row.state !== 'ready') draft.row = await uploadAttachment(workspaceId, taskId, actorId, draft.row, draft.file, draft.controller.signal, value => { draft.progress = value; redraw(); });
          if (draft.cancelled) await cancelServer(draft);
          draft.phase = 'done';
        } catch (caught) {
          draft.phase = 'error';
          if (draft.cancelled) { try { await cancelServer(draft); } catch (cancelError) { report(cancelError); } }
          else report(caught);
        } finally { await refresh(); redraw(); }
      }
    } finally { sending.current = false; redraw(); }
  };
  const select = (files: FileList | null) => {
    if (!files?.length || !features.data || !list.data) return;
    const picked = Array.from(files), limits = features.data.limits;
    setProblemKind(null);
    if (picked.length > list.data.remainingSlots) { setProblemKind('limit'); return; }
    if (picked.some(file => file.size > limits.maxFileSizeBytes)) { setProblemKind('tooLarge'); return; }
    if (picked.some(file => !attachmentNameSchema.safeParse(file.name).success)) { setProblemKind('invalidName'); return; }
    drafts.current = picked.map(file => ({ file, key: crypto.randomUUID(), controller: new AbortController(), cancelled: false, progress: 0, phase: 'queued' }));
    redraw(); void send();
  };
  const disabledReason = features.isError ? t('attachments.featureError') : !features.data ? t('attachments.loading')
    : !features.data.enabled ? t('attachments.notConfigured') : !writable ? t('attachments.readOnly')
    : list.isError ? t('attachments.loadFailed') : !list.data ? t('attachments.loading') : list.data.remainingSlots === 0 ? t('attachments.limit')
    : !list.data.canUpload ? t('attachments.readOnly') : sending.current ? t('attachments.uploading') : null;
  const remove = async (row: TaskAttachmentDto) => {
    setBusy(row.id); setProblemKind(null);
    try { await removeAttachment(workspaceId, taskId, actorId, row, crypto.randomUUID()); await refresh(); }
    catch (caught) { report(caught); await refresh(); }
    finally { if (alive.current) setBusy(null); }
  };
  const download = async (row: TaskAttachmentDto) => {
    // Open synchronously to avoid popup blocking while the authorized URL request is in flight.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy(row.id); setProblemKind(null);
    try {
      const result = await attachmentDownloadUrl(workspaceId, taskId, row.id);
      if (!alive.current) { tab?.close(); return false; }
      if (tab) tab.location.replace(result.url); else window.location.assign(result.url);
      return true;
    } catch (caught) { tab?.close(); report(caught); return false; }
    finally { if (alive.current) setBusy(null); }
  };
  const accessLost = list.error instanceof ApiError && ['unauthenticated', 'forbidden', 'not_found'].includes(list.error.kind);
  const visible = accessLost ? [] : list.data?.items ?? [];
  const preview = features.data?.enabled ? visible.find(row => row.id === previewId && row.state === 'ready') : undefined;
  return <section className="space-y-3 border-t border-line py-4" aria-label={t('attachments.title')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t('attachments.title')} <span className="font-normal text-muted">{t('attachments.count', { p0: visible.length, p1: features.data?.limits.maxFilesPerTask ?? MAX_TASK_ATTACHMENTS })}</span></h3>
      <span className="group relative inline-flex" tabIndex={disabledReason ? 0 : -1} aria-label={disabledReason ?? undefined}>
        <Button size="sm" disabled={disabledReason !== null} onClick={() => input.current?.click()}><Paperclip size={14} aria-hidden="true" />{t('attachments.attach')}</Button>
        {disabledReason ? <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden w-64 rounded-md border border-line bg-surface p-2 text-xs shadow-lg group-hover:block group-focus-within:block">{disabledReason}</span> : null}
      </span>
      <input ref={input} type="file" multiple hidden aria-label={t('attachments.attach')} onChange={event => { select(event.currentTarget.files); event.currentTarget.value = ''; }} />
    </div>
    <p className="text-xs text-muted">{t('attachments.limits', { p0: features.data?.limits.maxFilesPerTask ?? MAX_TASK_ATTACHMENTS, p1: (features.data?.limits.maxFileSizeBytes ?? MAX_ATTACHMENT_BYTES) / 1_000_000 })}</p>
    {(features.isError || list.isError) ? <div role="alert" className="text-sm text-muted">{t(accessLost ? 'attachments.accessChanged' : 'attachments.loadFailed')} <Button size="sm" onClick={() => { void features.refetch(); void list.refetch(); }}>{t('attachments.retry')}</Button></div> : null}
    {error ? <p role="alert" className="text-sm text-red-600">{errorLabels[error]}</p> : null}
    {visible.length ? <ul className="space-y-2">{visible.map(row => <li key={row.id} className="flex min-w-0 items-center gap-2 rounded-md border border-line p-2 text-sm">
      <div className="min-w-0 flex-1">{row.state === 'ready' && attachmentMedia(row.fileName)
        ? <button type="button" className="block max-w-full truncate text-left underline-offset-2 hover:underline focus-visible:underline disabled:cursor-not-allowed" title={row.fileName} disabled={!features.data?.enabled} onClick={() => setPreviewId(row.id)}>{row.fileName}</button>
        : <p className="truncate" title={row.fileName}>{row.fileName}</p>}<p className="text-xs text-muted">{t('attachments.bytes', { p0: formatNumber(row.sizeBytes) })}{row.state !== 'ready' ? ` · ${t('attachments.uploading')}` : ''}</p>
        <p className="text-xs text-muted">{t('attachments.uploaded', { p0: props.members?.find(member => member.userId === row.uploadedByUserId)?.displayName ?? (row.uploadedByUserId === actorId ? t('attachments.you') : t('attachments.member')), p1: formatDate(row.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</p></div>
      {row.state === 'ready' && attachmentMedia(row.fileName) ? <Button size="sm" aria-label={t('attachments.preview', { p0: row.fileName })} disabled={!features.data?.enabled} onClick={() => setPreviewId(row.id)}><Eye size={14} aria-hidden="true" /></Button> : null}
      {row.state === 'ready' ? <Button size="sm" aria-label={t('attachments.download', { p0: row.fileName })} disabled={busy === row.id || !features.data?.enabled} onClick={() => void download(row)}><Download size={14} aria-hidden="true" /></Button> : null}
      {writable && list.data?.canDelete ? <Button size="sm" aria-label={t('attachments.remove', { p0: row.fileName })} disabled={busy === row.id} onClick={() => void remove(row)}><Trash2 size={14} aria-hidden="true" /></Button> : null}
    </li>)}</ul> : !list.isPending && !list.isError ? <p className="text-sm text-muted">{t('attachments.empty')}</p> : null}
    {drafts.current.filter(draft => !accessLost && !draft.cancelled && draft.phase !== 'done').map((draft, index) => <div key={index} className="space-y-1 text-sm">
      <p className="truncate">{draft.file.name}</p>
      {draft.phase === 'uploading' ? <progress className="w-full" max={100} value={draft.progress} aria-label={t('attachments.progress', { p0: draft.file.name })} /> : null}
      <div className="flex gap-2">
        {draft.phase === 'error' ? <Button size="sm" disabled={sending.current} onClick={() => { draft.controller = new AbortController(); draft.phase = 'queued'; setProblemKind(null); void send(); }}>{t('attachments.retry')}</Button> : null}
        <Button size="sm" onClick={() => { draft.cancelled = true; draft.controller.abort(); if (draft.phase !== 'uploading') void cancelServer(draft).then(refresh).catch(report); redraw(); }}>{t('attachments.cancel')}</Button>
      </div>
    </div>)}
    {preview ? <AttachmentPreviewDialog key={preview.id} workspaceId={workspaceId} taskId={taskId} row={preview}
      onClose={() => setPreviewId(null)} onDownload={() => download(preview)} downloadBusy={busy === preview.id} /> : null}
  </section>;
}
