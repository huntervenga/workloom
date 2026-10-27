import { Paperclip } from 'lucide-react';
import { useTranslation } from '../../i18n';

/** Read-only task decoration; counts arrive with the task, never via per-row requests. */
export function AttachmentCount({ count }: { count: number | undefined }) {
  const { t, formatNumber } = useTranslation();
  if (count === undefined || count <= 0) return null;
  const label = count === 1 ? t('attachments.oneFile') : t('attachments.manyFiles', { p0: formatNumber(count) });
  return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center gap-1 text-xs text-muted tabular-nums">
    <Paperclip size={12} aria-hidden="true" />
    <span aria-hidden="true">{formatNumber(count)}</span>
  </span>;
}
