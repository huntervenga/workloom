import { useLayoutEffect, useRef, useState } from 'react';

/** Vertical centre of a row's current-date track and the track's left edge, in host pixels. */
export interface ConnectorAnchor { y: number; trackLeft: number }
export type ConnectorAnchors = Readonly<Record<string, ConnectorAnchor>>;
interface Measurement { identity: string; host: HTMLElement; anchors: ConnectorAnchors }
export const anchorAttribute = 'data-gantt-anchor';
const rowSelector = '[data-gantt-row]';
function sameAnchors(left: ConnectorAnchors, right: ConnectorAnchors): boolean {
  const ids = Object.keys(left);
  return ids.length === Object.keys(right).length && ids.every(id => left[id]?.y === right[id]?.y && left[id]?.trackLeft === right[id]?.trackLeft);
}

/**
 * Measures the actually rendered current-bar tracks of the given rows inside the host, like
 * useGraphNodeSizes: results belong to one input identity and one host element, so a scope,
 * window, data or access change hides old lines until the current layout has been measured.
 * Row size changes (baseline lines, blockers, wrapping) and viewport/font changes re-measure once per frame.
 */
export function useConnectorAnchors(identity: string, ids: readonly string[], enabled: boolean) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const current = useRef(identity); current.current = identity;
  const key = ids.join(',');
  useLayoutEffect(() => {
    if (!enabled || !host || !key) return undefined;
    const wanted = key.split(',');
    let active = true, frame = 0;
    const measure = () => {
      if (!active || current.current !== identity || !host.isConnected) return;
      const base = host.getBoundingClientRect();
      const anchors: Record<string, ConnectorAnchor> = {};
      for (const id of wanted) {
        const node = host.querySelector<HTMLElement>(`[${anchorAttribute}="${id}"]`);
        const rect = node?.getBoundingClientRect();
        // An anchor that is missing or not laid out means the layout is not current: draw nothing.
        if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.left) || rect.height <= 0 || rect.width <= 0) return;
        anchors[id] = { y: Math.round((rect.top - base.top + rect.height / 2) * 10) / 10, trackLeft: Math.round((rect.left - base.left) * 10) / 10 };
      }
      setMeasurement(before => before?.identity === identity && before.host === host && sameAnchors(before.anchors, anchors) ? before : { identity, host, anchors });
    };
    const schedule = () => { if (frame || !active) return; frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(host);
    for (const row of host.querySelectorAll(rowSelector)) observer?.observe(row);
    measure();
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    return () => { active = false; if (frame) cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', schedule); document.fonts?.removeEventListener('loadingdone', schedule); };
  }, [enabled, host, identity, key]);
  const anchors = enabled && host && measurement?.identity === identity && measurement.host === host ? measurement.anchors : null;
  return { hostRef: setHost, anchors };
}
