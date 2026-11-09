import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attachmentMedia, attachmentNameSchema, type MembershipDto, type TaskAttachmentDto, type TaskTimelineItemDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { Download, FileUp, Paperclip, Play, Trash2 } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { UserAvatar } from '../../shared/UserAvatar';
import { invalidateTaskTimelines } from '../task-comments/queries';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import { attachmentDownloadUrl, attachmentPreviewUrl, fetchAttachment, fetchAttachmentFeatures, fetchAttachments, removeAttachment, reserveAttachment, uploadAttachment } from './api';

interface Props { actorId: string; workspaceId: string; taskId: string; writable: boolean; members?: readonly MembershipDto[]; children: ReactNode }
interface Draft { file: File; inDescription?: true | undefined; key: string; row?: TaskAttachmentDto; controller: AbortController; cancelled: boolean; progress: number; phase: 'queued' | 'uploading' | 'error' | 'done'; }
const keys = (props: Props) => ['attachments', props.actorId, props.workspaceId, props.taskId] as const;

interface AttachmentSurface {
  actorId: string;
  workspaceId: string;
  taskId: string;
  members: readonly MembershipDto[] | undefined;
  rows: readonly TaskAttachmentDto[];
  enabled: boolean;
  canDelete: boolean;
  busy: string | null;
  disabledReason: string | null;
  dropTarget: 'task' | 'description' | null;
  choose(): void;
  preview(id: string): void;
  download(row: TaskAttachmentDto): Promise<boolean>;
  remove(row: TaskAttachmentDto): Promise<void>;
}
const AttachmentContext = createContext<AttachmentSurface | null>(null);
export const useTaskAttachments = () => useContext(AttachmentContext);
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** Changing account or task unmounts all local drafts and cancels their byte streams. */
export function TaskAttachments(props: Props) {
  return <AttachmentPanel key={`${props.actorId}:${props.workspaceId}:${props.taskId}`} {...props} />;
}
function AttachmentPanel(props: Props) {
  const { actorId, workspaceId, taskId, writable } = props;
  const { t } = useTranslation(), client = useQueryClient();
  const errorLabels = { limit: t('attachments.limit'), tooLarge: t('attachments.tooLarge'), accessChanged: t('attachments.accessChanged'),
    changed: t('attachments.changed'), failed: t('attachments.failed'), invalidName: t('attachments.invalidName') };
  const input = useRef<HTMLInputElement>(null), alive = useRef(true), drafts = useRef<Draft[]>([]), sending = useRef(false);
  const [, setRender] = useState(0), [error, setProblemKind] = useState<keyof typeof errorLabels | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<AttachmentSurface['dropTarget']>(null);
  const features = useQuery({ queryKey: ['server-features', actorId], queryFn: ({ signal }) => fetchAttachmentFeatures(signal), staleTime: 60_000, retry: false });
  const list = useQuery({ queryKey: keys(props), queryFn: ({ signal }) => fetchAttachments(workspaceId, taskId, signal), retry: false,
    refetchInterval: query => query.state.data?.items.some(row => row.state !== 'ready') ? 5000 : false });
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const draft of drafts.current) draft.controller.abort(); }; }, []);
  const redraw = () => { if (alive.current) setRender(value => value + 1); };
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: keys(props) }),
    invalidateTaskTimelines(client, actorId, workspaceId, [taskId]),
    // Counts change in the project rows; the task detail and its comment pages can stay put.
    client.invalidateQueries({ queryKey: queryKeys.tasks(actorId, workspaceId), predicate: ({ queryKey }) => queryKey[5] === 'list' || queryKey[5] === 'my' }),
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
          const reserve = () => reserveAttachment(workspaceId, taskId, actorId, draft.file, draft.key, draft.controller.signal, draft.inDescription);
          draft.row = await reserve();
          if (draft.cancelled) { await cancelServer(draft); continue; }
          if (['failed', 'expired', 'deleted'].includes(draft.row.state)) {
            draft.key = crypto.randomUUID();
            draft.row = await reserve();
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
  const disabledReason = !writable ? t('attachments.readOnly') : features.isError ? t('attachments.featureError') : !features.data ? t('attachments.loading')
    : !features.data.enabled ? t('attachments.notConfigured')
    : list.isError ? t('attachments.loadFailed') : !list.data ? t('attachments.loading') : list.data.remainingSlots === 0 ? t('attachments.limit')
    : !list.data.canUpload ? t('attachments.readOnly') : sending.current ? t('attachments.uploading') : null;
  const select = (files: FileList | null, inDescription?: true) => {
    if (!files?.length || sending.current) return;
    const picked = Array.from(files);
    setProblemKind(null);
    if (list.data && picked.length > list.data.remainingSlots) { setProblemKind('limit'); return; }
    if (disabledReason || !features.data || !list.data) return;
    if (picked.some(file => file.size > features.data.limits.maxFileSizeBytes)) { setProblemKind('tooLarge'); return; }
    if (picked.some(file => !attachmentNameSchema.safeParse(file.name).success)) { setProblemKind('invalidName'); return; }
    drafts.current = [...drafts.current.filter(draft => !draft.cancelled && draft.phase === 'error'),
      ...picked.map(file => ({ file, inDescription, key: crypto.randomUUID(), controller: new AbortController(), cancelled: false, progress: 0, phase: 'queued' as const }))];
    redraw(); void send();
  };
  const onFileDrop = useEffectEvent(select);
  const allowDrop = useEffectEvent(() => disabledReason === null);
  useEffect(() => {
    const element = input.current;
    const panel = element?.closest('[data-task-panel]') ?? element?.parentElement;
    if (!panel) return;
    const location = (target: EventTarget | null) => target instanceof Element && target.closest('[data-attachment-description]') ? 'description' : 'task';
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      if (!(event.target instanceof Node) || !panel.contains(event.target)) { setDropTarget(null); return; }
      event.preventDefault();
      const allowed = allowDrop();
      if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
      setDropTarget(allowed ? location(event.target) : null);
    };
    const drop = (event: DragEvent) => {
      setDropTarget(null);
      if (!hasFiles(event) || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      event.preventDefault();
      onFileDrop(event.dataTransfer?.files ?? null, location(event.target) === 'description' ? true : undefined);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event) || event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) return;
      const { left, right, top, bottom } = panel.getBoundingClientRect();
      if (event.clientX <= left || event.clientX >= right || event.clientY <= top || event.clientY >= bottom) setDropTarget(null);
    };
    const end = () => setDropTarget(null);
    document.addEventListener('dragover', over, true);
    document.addEventListener('drop', drop, true);
    panel.addEventListener('dragleave', leave as EventListener);
    window.addEventListener('dragend', end);
    window.addEventListener('blur', end);
    return () => {
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('drop', drop, true);
      panel.removeEventListener('dragleave', leave as EventListener);
      window.removeEventListener('dragend', end);
      window.removeEventListener('blur', end);
    };
  }, []);
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
  const ready = visible.filter(row => row.state === 'ready');
  const surface: AttachmentSurface = {
    actorId, workspaceId, taskId, members: props.members, rows: ready, enabled: features.data?.enabled === true,
    canDelete: writable && list.data?.canDelete === true, busy, disabledReason, dropTarget, choose: () => input.current?.click(),
    preview: setPreviewId, download, remove,
  };
  const feedback = (features.isError || list.isError || error || drafts.current.some(draft => !draft.cancelled && draft.phase !== 'done'));
  return <AttachmentContext.Provider value={surface}>
    <input ref={input} type="file" multiple hidden aria-label={t('attachments.attach')} onChange={event => { select(event.currentTarget.files); event.currentTarget.value = ''; }} />
    {dropTarget === 'task' ? <div role="status" className="pointer-events-none absolute inset-2 z-20 flex items-start justify-center rounded-xl border-2 border-dashed border-accent bg-accent/5 pt-12">
      <span className="flex items-center gap-2 rounded-lg border border-accent/30 bg-surface px-4 py-2 text-sm font-medium text-accent shadow-md"><FileUp size={17} aria-hidden="true" />{t('attachments.dropTask')}</span>
    </div> : null}
    {feedback ? <div className="absolute right-5 bottom-16 z-20 max-h-40 w-[22rem] max-w-[calc(100%_-_2.5rem)] space-y-2 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-lg">
    {(features.isError || list.isError) ? <div role="alert" className="text-sm text-muted">{t(accessLost ? 'attachments.accessChanged' : 'attachments.loadFailed')} <Button size="sm" onClick={() => { void features.refetch(); void list.refetch(); }}>{t('attachments.retry')}</Button></div> : null}
    {error ? <p role="alert" className="text-sm text-red-600">{errorLabels[error]}</p> : null}
    {drafts.current.filter(draft => !accessLost && !draft.cancelled && draft.phase !== 'done').map(draft => <div key={draft.key} className="space-y-1 text-sm">
      <p className="truncate">{draft.file.name}</p>
      {draft.phase === 'uploading' ? <progress className="w-full" max={100} value={draft.progress} aria-label={t('attachments.progress', { p0: draft.file.name })} /> : null}
      <div className="flex gap-2">
        {draft.phase === 'error' ? <Button size="sm" disabled={sending.current} onClick={() => { draft.controller = new AbortController(); draft.phase = 'queued'; setProblemKind(null); void send(); }}>{t('attachments.retry')}</Button> : null}
        <Button size="sm" onClick={() => { draft.cancelled = true; draft.controller.abort(); if (draft.phase !== 'uploading') void cancelServer(draft).then(refresh).catch(report); redraw(); }}>{t('attachments.cancel')}</Button>
      </div>
    </div>)}
    </div> : null}
    {props.children}
    {preview ? <AttachmentPreviewDialog key={preview.id} workspaceId={workspaceId} taskId={taskId} row={preview}
      onClose={() => setPreviewId(null)} onDownload={() => download(preview)} downloadBusy={busy === preview.id} /> : null}
  </AttachmentContext.Provider>;
}

export function AttachFileButton() {
  const { t } = useTranslation();
  const surface = useTaskAttachments();
  if (!surface) return null;
  return <span className="group relative inline-flex" tabIndex={surface.disabledReason ? 0 : -1} aria-label={surface.disabledReason ?? undefined}>
    <Button type="button" size="sm" variant="ghost" aria-label={t('attachments.attach')} title={t('attachments.attach')}
      disabled={surface.disabledReason !== null} onClick={surface.choose}><Paperclip size={17} aria-hidden="true" /></Button>
    {surface.disabledReason ? <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-56 rounded-md border border-line bg-surface p-2 text-xs shadow-lg group-hover:block group-focus-within:block">{surface.disabledReason}</span> : null}
  </span>;
}

export function AttachmentDescription({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const surface = useTaskAttachments();
  if (!surface) return children;
  const active = surface.dropTarget === 'description';
  const rows = surface.rows.filter(row => row.inDescription);
  return <div data-attachment-description="" className="relative rounded-lg">
    {children}
    {rows.length ? <div className="mt-2 flex flex-wrap gap-2">{rows.map(row => <AttachmentCard key={row.id} row={row} inline />)}</div> : null}
    {active ? <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-surface/90 px-2">
      <span className="flex items-center gap-2 text-sm font-medium text-accent"><FileUp size={17} aria-hidden="true" />{t('attachments.dropDescription')}</span>
    </div> : null}
  </div>;
}

export function AttachmentTimelineEntry({ item, time }: { item: Extract<TaskTimelineItemDto, { type: 'attachment' }>; time: string }) {
  const { t } = useTranslation();
  const surface = useTaskAttachments();
  const row = item.action === 'created' ? surface?.rows.find(file => file.id === item.attachmentId) : undefined;
  return <li data-attachment-activity={item.attachmentId} className="rounded-lg border border-line bg-surface p-2.5">
    <div className="flex flex-wrap items-center gap-x-2 text-xs">
      <UserAvatar name={item.actorDisplayName} seed={item.actorUserId} avatarUrl={item.actorAvatarUrl ?? null} size="sm" />
      <span className="font-medium text-ink">{t(item.action === 'created' ? 'attachments.activityAdded' : 'attachments.activityRemoved', { name: item.actorDisplayName })}</span>
      <time dateTime={item.occurredAt} className="text-muted">{time}</time>
    </div>
    {row ? <div className="mt-1.5 pl-8"><AttachmentCard row={row} /></div> : null}
  </li>;
}

function AttachmentActivity({ row, time }: { row: TaskAttachmentDto; time: string }) {
  const { t } = useTranslation();
  const surface = useTaskAttachments();
  if (!surface) return null;
  const member = surface.members?.find(member => member.userId === row.uploadedByUserId);
  const name = member?.displayName ?? t(row.uploadedByUserId === surface.actorId ? 'attachments.you' : 'attachments.member');
  return <li data-attachment-activity={row.id} className="rounded-lg border border-line bg-surface p-2.5">
    <div className="flex flex-wrap items-center gap-x-2 text-xs">
      <UserAvatar name={name} seed={row.uploadedByUserId} avatarUrl={member?.avatarUrl ?? null} size="sm" />
      <span className="font-medium text-ink">{t('attachments.activityAdded', { name })}</span>
      <time dateTime={row.createdAt} className="text-muted">{time}</time>
    </div>
    <div className="mt-1.5 pl-8"><AttachmentCard row={row} /></div>
  </li>;
}

/** Used by entry points without a comments controller; the normal drawer merges files into its feed. */
export function AttachmentActivityFallback() {
  const { t, formatDate } = useTranslation();
  const rows = useTaskAttachments()?.rows;
  return rows?.length ? <ol aria-label={t('activity.heading')} className="space-y-2">
    {rows.map(row => <AttachmentActivity key={row.id} row={row} time={formatDate(row.createdAt, { dateStyle: 'medium', timeStyle: 'short' })} />)}
  </ol> : null;
}

function AttachmentCard({ row, inline = false }: { row: TaskAttachmentDto; inline?: boolean }) {
  const { t, formatNumber } = useTranslation();
  const surface = useTaskAttachments();
  if (!surface) return null;
  const media = attachmentMedia(row.fileName);
  const isImage = media?.kind === 'image';
  const Icon = media?.kind === 'video' ? Play : Paperclip;
  return <div className={`group/file w-fit min-w-0 max-w-full rounded-lg border border-line bg-canvas/40 ${isImage ? inline ? 'w-80' : 'w-60' : ''}`}>
    {isImage && surface.enabled ? <button type="button" className="block w-full overflow-hidden rounded-t-lg bg-canvas text-left" aria-label={t('attachments.preview', { p0: row.fileName })} onClick={() => surface.preview(row.id)}>
      <AttachmentImage workspaceId={surface.workspaceId} taskId={surface.taskId} row={row} inline={inline} />
    </button> : null}
    <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-1">
      {!isImage || !surface.enabled ? <Icon size={15} className="mx-1 shrink-0 text-muted" aria-hidden="true" /> : null}
      <button type="button" className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-sm font-medium text-ink hover:text-accent disabled:opacity-60"
        title={row.fileName} aria-label={media?.kind === 'video' ? t('attachments.preview', { p0: row.fileName }) : undefined} disabled={!surface.enabled || surface.busy === row.id}
        onClick={() => { if (media) surface.preview(row.id); else void surface.download(row); }}>{row.fileName}</button>
      <span className="sr-only">{t('attachments.bytes', { p0: formatNumber(row.sizeBytes) })}</span>
      <Button size="sm" variant="ghost" aria-label={t('attachments.download', { p0: row.fileName })} title={t('attachments.download', { p0: row.fileName })}
        disabled={!surface.enabled || surface.busy === row.id} onClick={() => void surface.download(row)}><Download size={14} aria-hidden="true" /></Button>
      {!inline && surface.canDelete ? <Button size="sm" variant="ghost" aria-label={t('attachments.remove', { p0: row.fileName })} title={t('attachments.remove', { p0: row.fileName })}
        disabled={surface.busy === row.id} onClick={() => void surface.remove(row)}><Trash2 size={14} aria-hidden="true" /></Button> : null}
    </div>
  </div>;
}

function AttachmentImage({ workspaceId, taskId, row, inline }: { workspaceId: string; taskId: string; row: TaskAttachmentDto; inline: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void attachmentPreviewUrl(workspaceId, taskId, row.id, controller.signal).then(result => {
        if (!controller.signal.aborted && result.kind === 'image') setUrl(result.url);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    };
    const element = target.current;
    const observer = typeof IntersectionObserver !== 'undefined' && element ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: '150px' }) : null;
    if (observer && element) observer.observe(element); else load();
    return () => { observer?.disconnect(); controller.abort(); };
  }, [workspaceId, taskId, row.id]);
  return <span ref={target} className={`flex w-full items-center justify-center overflow-hidden bg-canvas ${inline ? 'h-40' : 'h-28'}`}>
    {url && !failed ? <img src={url} alt={row.fileName} referrerPolicy="no-referrer" draggable={false} decoding="async"
      className="h-full w-full object-contain" onError={() => setFailed(true)} /> : <Paperclip size={22} className="text-muted" aria-hidden="true" />}
  </span>;
}
