import { useEffect, useRef, useState } from 'react';
import type { AttachmentPreview, TaskAttachmentDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { Download } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { attachmentPreviewUrl } from './api';

interface Props {
  workspaceId: string;
  taskId: string;
  row: TaskAttachmentDto;
  onClose(): void;
  onDownload(): Promise<boolean>;
  downloadBusy: boolean;
}

export function AttachmentPreviewDialog(props: Props) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [downloadFailed, setDownloadFailed] = useState(false);
  return <DialogShell open onOpenChange={open => { if (!open) props.onClose(); }} variant="media"
    title={props.row.fileName} description={t('attachments.previewDescription')}>
    <PreviewSession key={attempt} workspaceId={props.workspaceId} taskId={props.taskId} row={props.row}
      onRetry={() => setAttempt(value => value + 1)} />
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
      {downloadFailed ? <p role="alert" className="text-sm text-muted">{t('attachments.failed')}</p> : null}
      <Button size="sm" disabled={props.downloadBusy} onClick={async () => {
        setDownloadFailed(false);
        setDownloadFailed(!await props.onDownload());
      }}><Download size={14} aria-hidden="true" />{t('attachments.previewDownload')}</Button>
    </div>
  </DialogShell>;
}

type PreviewState = { phase: 'loading' } | { phase: 'ready'; preview: AttachmentPreview }
  | { phase: 'error'; reason: 'access' | 'request' | 'media' };

/** A fresh mounted session owns the signed URL; it never enters query caches or browser storage. */
function PreviewSession({ workspaceId, taskId, row, onRetry }: Pick<Props, 'workspaceId' | 'taskId' | 'row'> & { onRetry(): void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<PreviewState>({ phase: 'loading' });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void attachmentPreviewUrl(workspaceId, taskId, row.id, controller.signal).then(preview => {
      if (!controller.signal.aborted) setState({ phase: 'ready', preview });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const reason = error instanceof ApiError && ['unauthenticated', 'forbidden', 'not_found'].includes(error.kind) ? 'access'
        : error instanceof ApiError && error.status === 415 ? 'media' : 'request';
      setState({ phase: 'error', reason });
    });
    return () => controller.abort();
  }, [workspaceId, taskId, row.id]);
  return <div className="mt-4 space-y-3">
    {state.phase !== 'error' && !loaded ? <p role="status" className="text-sm text-muted">{t('attachments.previewLoading')}</p> : null}
    {state.phase === 'ready' ? <PreviewMedia preview={state.preview} fileName={row.fileName}
      onLoad={() => setLoaded(true)} onError={() => setState({ phase: 'error', reason: 'media' })} /> : null}
    {state.phase === 'error' ? <div className="space-y-3 rounded-lg border border-line p-4">
      <p role="alert" className="text-sm text-muted">{state.reason === 'access' ? t('attachments.accessChanged')
        : state.reason === 'media' ? t('attachments.previewUnsupported') : t('attachments.previewFailed')}</p>
      <Button size="sm" onClick={onRetry}>{t('attachments.retry')}</Button>
    </div> : null}
  </div>;
}

function PreviewMedia({ preview, fileName, onLoad, onError }: {
  preview: AttachmentPreview; fileName: string; onLoad(): void; onError(): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.src = preview.url;
    return () => {
      // Release playback and outstanding range requests when closed, retried, or access changes.
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    };
  }, [preview.url]);
  return <div className="flex min-h-32 items-center justify-center overflow-hidden rounded-lg bg-black/90">
    {preview.kind === 'image'
      ? <img src={preview.url} alt={fileName} referrerPolicy="no-referrer" className="max-h-[65dvh] max-w-full object-contain" onLoad={onLoad} onError={onError} />
      : <video ref={videoRef} aria-label={fileName} controls playsInline preload="metadata"
        className="max-h-[65dvh] w-full object-contain" onLoadedMetadata={onLoad} onError={onError} />}
  </div>;
}
