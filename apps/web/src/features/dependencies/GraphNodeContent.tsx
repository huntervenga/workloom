import type { TaskStatusGroup } from '@workloom/contracts';
import type { CSSProperties } from 'react';
import { useTranslation } from '../../i18n';

/** An absent statusGroup is unknown: the node is never presented as done and its edges stay unresolved. */
export interface GraphCanvasTask { id: string; title: string; projectName: string; statusName: string; blocked: boolean; unresolvedCount: number; archived: boolean; statusGroup?: TaskStatusGroup | undefined; violatesCurrentStatus?: boolean | undefined }
export class GraphLayoutBoundsError extends Error {}
export interface GraphNodeSize { width: number; height: number }
/** Shared with the unscaled measurement host; no content-dependent clipping or fixed height. */
export const graphNodeBoxStyle: CSSProperties = { width: 240, minHeight: 128, padding: 10, boxSizing: 'border-box', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--color-line)', borderRadius: 12, background: 'var(--color-surface)', fontSize: 12, lineHeight: 1.5 };

export function GraphNodeContent({ task, onOpen, onViewBlockers, measuring = false }: {
  task: GraphCanvasTask;
  onOpen?: ((id: string) => void) | undefined;
  onViewBlockers?: ((id: string) => void) | undefined;
  measuring?: boolean;
}) {
  const { t } = useTranslation();
  return <div className="flex min-w-0 flex-col items-stretch gap-2 text-left">
    <button type="button" tabIndex={measuring ? -1 : undefined} className="nodrag nopan min-w-0 w-full rounded text-left text-sm font-semibold text-accent-ink [overflow-wrap:anywhere]" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onOpen?.(task.id); }}>{task.title}</button>
    <p className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">{task.projectName} · {task.statusName}{task.archived ? t('dependencies.graphCanvas.archived') : ''}</p>
    {task.statusGroup === 'done' ? <p className="min-w-0 text-xs text-emerald-800 [overflow-wrap:anywhere]">{t('dependencies.graphCanvas.doneResolvesSuccessors')}</p> : null}
    {task.blocked ? <p className="min-w-0 text-xs text-amber-800 [overflow-wrap:anywhere]">{t('dependencies.graphCanvas.hasUnfinishedPredecessors')}</p> : null}
    {task.violatesCurrentStatus ? <p className="min-w-0 text-xs font-medium text-red-800 [overflow-wrap:anywhere]">{t('dependencies.graphCanvas.statusConflictsWithBlockingRule')}</p> : null}
    <button type="button" tabIndex={measuring ? -1 : undefined} className="nodrag nopan inline-flex min-h-6 min-w-0 max-w-full items-center self-start rounded text-left text-xs font-medium whitespace-normal text-accent-ink underline [overflow-wrap:anywhere]" aria-label={measuring ? undefined : t('dependencies.graphBlockers.viewForTask', { title: task.title, count: task.unresolvedCount })} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onViewBlockers?.(task.id); }}>{t('dependencies.graphBlockers.view', { count: task.unresolvedCount })}</button>
  </div>;
}
