import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { GraphNodeContent, graphNodeBoxStyle, type GraphCanvasTask, type GraphNodeSize } from './GraphNodeContent';

export type GraphNodeSizes = Readonly<Record<string, GraphNodeSize>>;
interface Measurement { identity: string; sizes: GraphNodeSizes }
const emptySizes: GraphNodeSizes = Object.freeze({});
function sameSizes(left: GraphNodeSizes, right: GraphNodeSizes): boolean {
  const ids = Object.keys(left);
  return ids.length === Object.keys(right).length && ids.every(id => left[id]?.width === right[id]?.width && left[id]?.height === right[id]?.height);
}

/** Measure the exact node content even in List mode, without mounting the lazy Canvas. */
export function useGraphNodeSizes(tasks: readonly GraphCanvasTask[], scope: string, enabled: boolean) {
  const { locale } = useTranslation();
  const identity = JSON.stringify([scope, locale, enabled, tasks]);
  const current = useRef(identity); current.current = identity;
  const host = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!enabled || !element || tasks.length === 0) return undefined;
    let active = true;
    const measure = () => {
      if (!active || current.current !== identity || !element.isConnected) return;
      const sizes: Record<string, GraphNodeSize> = {};
      for (const node of element.querySelectorAll<HTMLElement>('[data-graph-measure-node]')) {
        const id = node.dataset.graphMeasureNode;
        const rect = node.getBoundingClientRect();
        if (!id || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return;
        sizes[id] = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      }
      if (Object.keys(sizes).length !== tasks.length) return;
      setMeasurement(before => before?.identity === identity && sameSizes(before.sizes, sizes) ? before : { identity, sizes });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const node of element.querySelectorAll('[data-graph-measure-node]')) observer?.observe(node);
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(() => measure());
    return () => { active = false; observer?.disconnect(); window.removeEventListener('resize', measure); document.fonts?.removeEventListener('loadingdone', measure); };
  }, [enabled, identity, tasks.length]);
  const sizes = !enabled ? null : tasks.length === 0 ? emptySizes : measurement?.identity === identity ? measurement.sizes : null;
  const measurementHost = enabled && tasks.length ? <div key={identity} ref={host} aria-hidden="true" inert data-graph-measurement-host style={{ position: 'fixed', left: -10000, top: 0, width: 240, height: 0, overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none', contain: 'layout' }}>
    {tasks.map(task => <div key={task.id} data-graph-measure-node={task.id} style={graphNodeBoxStyle}><GraphNodeContent task={task} measuring /></div>)}
  </div> : null;
  return { sizes, identity, measurementHost };
}
