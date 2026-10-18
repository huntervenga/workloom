import { arrowHead, connectorPath, type ConnectorPlan } from './connectors';
import type { ConnectorAnchors } from './useConnectorAnchors';

export const connectorStyles = {
  compatible: { stroke: 'var(--color-gantt-compatible)', strokeWidth: 1.5, strokeDasharray: undefined },
  conflict: { stroke: 'var(--color-gantt-conflict)', strokeWidth: 2, strokeDasharray: '5,3' },
} as const;
/**
 * Non-interactive finish-to-start arrows drawn from current measurements only. It sits above the
 * track background and below bars and the sticky task column; the counts and reasons are in text.
 */
export function GanttConnectors({ plan, anchors, label }: { plan: ConnectorPlan; anchors: ConnectorAnchors | null; label: string }) {
  if (!anchors || !plan.drawn.length) return null;
  const lines = plan.drawn.flatMap(item => {
    const from = anchors[item.from.taskId], to = anchors[item.to.taskId];
    return from && to ? [{ ...item, fromX: from.trackLeft + item.from.x, fromY: from.y, toX: to.trackLeft + item.to.x, toY: to.y }] : [];
  });
  if (lines.length !== plan.drawn.length) return null;
  return <svg role="img" aria-label={label} data-gantt-connectors="" className="pointer-events-none absolute top-0 left-0 z-[1] size-full overflow-visible">
    {lines.map(line => { const style = connectorStyles[line.state]; return <g key={line.dependencyId} data-dependency-id={line.dependencyId} data-state={line.state}>
      <path d={connectorPath(line.fromX, line.fromY, line.toX, line.toY)} fill="none" stroke={style.stroke} strokeWidth={style.strokeWidth} strokeDasharray={style.strokeDasharray} strokeLinejoin="round" />
      <path d={arrowHead(line.toX, line.toY)} fill={style.stroke} />
    </g>; })}
  </svg>;
}
