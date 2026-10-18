import type { OriginalEstimateOriginDto, OriginalPackageEstimateDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { useId } from 'react';
import { useTranslation } from '../../i18n';
import { isAccessDenied } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { formatEstimate } from '../task-table';
import { useOriginalPackageEstimateQuery } from './queries';

interface Props {
  actorId: string;
  workspaceId: string;
  /** The whole work package; detail children share their root's original. */
  packageId: string;
  /** Compact disclosure for the task estimate field; the default full read stays unchanged. */
  compact?: boolean | undefined;
}

/**
 * Read-only original whole-package estimate from the first related plan freeze. It never shows or
 * derives from the current estimate: callers render the current value separately.
 */
export function OriginalEstimate({ actorId, workspaceId, packageId, compact = false }: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  // A malformed target is never requested: the read component (and its query) does not mount.
  return <section aria-labelledby={labelId} className="space-y-1.5 text-sm">
    <h3 id={labelId} className={compact ? 'sr-only' : 'text-xs font-medium text-muted'}>{t('original-estimate.label')}</h3>
    {isUuid(workspaceId) && isUuid(packageId)
      ? <OriginalEstimateRead actorId={actorId} workspaceId={workspaceId} packageId={packageId} compact={compact} />
      : <p className="text-xs text-muted">{t('original-estimate.unavailable')}</p>}
  </section>;
}

function OriginalEstimateRead({ actorId, workspaceId, packageId, compact = false }: Props) {
  const { t } = useTranslation();
  const query = useOriginalPackageEstimateQuery(actorId, workspaceId, packageId);
  // A current denial overrides retained query data and background refetch/loading states.
  if (isAccessDenied(query.error)) return <p role="alert" className="text-xs text-muted">{t('original-estimate.unavailable')}</p>;
  const value = query.data;
  // Never show an original read for another package or workspace, even if the server answered successfully.
  const current = value && value.workPackageId === packageId.toLowerCase() && value.workspaceId === workspaceId.toLowerCase() ? value : null;
  if (current !== null) return <OriginalValue value={current} compact={compact} />;
  if (query.isPending || query.isFetching) return <p role="status" className="text-xs text-muted">{t('original-estimate.loading')}</p>;
  // A failed or out-of-scope response is a neutral failure that never echoes payload IDs.
  return <div className="space-y-1 text-xs text-muted">
    <p role="alert">{t('original-estimate.loadFailed')}</p>
    <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>{t('original-estimate.retry')}</Button>
  </div>;
}

function OriginalValue({ value, compact }: { value: OriginalPackageEstimateDto; compact: boolean }) {
  const { t } = useTranslation();
  if (compact) {
    const state = value.state;
    return <details className="text-xs text-muted">
      <summary className="cursor-pointer leading-relaxed">
        <span>{t('original-estimate.label')}: </span>
        <span className="font-medium tabular-nums">{state === 'captured' ? formatEstimate(value.estimateMinutes) : t(`original-estimate.state.${state}`)}</span>{' '}
        <Badge tone={state === 'captured' ? 'accent' : state === 'original_unknown' ? 'warning' : 'muted'}>{t(`original-estimate.badge.${state}`)}</Badge>
      </summary>
      <div className="mt-1.5 space-y-1">
        <p className="leading-relaxed">{t(`original-estimate.help.${state}`)}</p>
        {value.state !== 'not_captured_yet' ? <Origin origin={value.origin} /> : null}
      </div>
    </details>;
  }
  if (value.state === 'not_captured_yet') return <div className="space-y-1">
    <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{t('original-estimate.state.not_captured_yet')}</span><Badge tone="muted">{t('original-estimate.badge.not_captured_yet')}</Badge></p>
    <p className="text-xs leading-relaxed text-muted">{t('original-estimate.help.not_captured_yet')}</p>
  </div>;
  if (value.state === 'original_unknown') return <div className="space-y-1">
    <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{t('original-estimate.state.original_unknown')}</span><Badge tone="warning">{t('original-estimate.badge.original_unknown')}</Badge></p>
    <p className="text-xs leading-relaxed text-muted">{t('original-estimate.help.original_unknown')}</p>
    <Origin origin={value.origin} />
  </div>;
  return <div className="space-y-1">
    <p className="flex flex-wrap items-center gap-2"><span className="font-medium tabular-nums">{formatEstimate(value.estimateMinutes)}</span><Badge tone="accent">{t('original-estimate.badge.captured')}</Badge></p>
    <p className="text-xs leading-relaxed text-muted">{t('original-estimate.help.captured')}</p>
    <Origin origin={value.origin} />
  </div>;
}

/** Every value comes from the immutable originating freeze, never from the time of this read. */
function Origin({ origin }: { origin: OriginalEstimateOriginDto }) {
  const { t, formatDate } = useTranslation();
  return <p className="text-xs text-muted">{t('original-estimate.origin.frozen', {
    frozenAt: formatDate(origin.frozenAt, { dateStyle: 'medium', timeStyle: 'short' }),
    week: formatDate(origin.periodLocalStart, { dateStyle: 'medium' }),
    scope: origin.scope === 'self' ? t('original-estimate.origin.scope.self') : t('original-estimate.origin.scope.project'),
    mode: origin.mode === 'cutoff' ? t('original-estimate.origin.mode.cutoff') : t('original-estimate.origin.mode.manual'),
  })}</p>;
}
