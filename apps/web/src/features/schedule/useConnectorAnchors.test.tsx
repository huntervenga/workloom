import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorAttribute, useConnectorAnchors } from './useConnectorAnchors';

// jsdom has no layout: rows report explicit rects and the test delivers observer/frame callbacks itself.
let layout: Record<string, { top: number; height: number } | undefined>;
let observers: { callback: ResizeObserverCallback; observed: Element[]; disconnected: boolean }[];
let frames: FrameRequestCallback[];
let restore: () => void;
beforeEach(() => {
  layout = { a: { top: 100, height: 24 }, b: { top: 160, height: 24 } }; observers = []; frames = [];
  const original = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.host !== undefined) return new DOMRect(10, 40, 1200, 400);
    const id = this.getAttribute(anchorAttribute);
    if (id) { const rect = layout[id]; return rect ? new DOMRect(250, rect.top, 1008, rect.height) : new DOMRect(0, 0, 0, 0); }
    return original.call(this);
  });
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, observed: [], disconnected: false }; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.push(element); }
    unobserve() { /* Not used. */ }
    disconnect() { this.entry.disconnected = true; }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  restore = () => { spy.mockRestore(); vi.unstubAllGlobals(); };
});
afterEach(() => restore());
let latest: ReturnType<typeof useConnectorAnchors>;
function Host({ identity = 'scope-1', ids = ['a', 'b'], enabled = true, rows = ['a', 'b'], hostKey = 'one' }: { identity?: string; ids?: string[]; enabled?: boolean; rows?: string[]; hostKey?: string }) {
  latest = useConnectorAnchors(identity, ids, enabled);
  return enabled ? <div key={hostKey} ref={latest.hostRef} data-host="">{rows.map(id => <div key={id} data-gantt-row=""><div {...{ [anchorAttribute]: id }} /></div>)}</div> : null;
}
const deliver = () => { const entry = observers.at(-1); if (!entry) throw new Error('Missing observer'); entry.callback([], {} as ResizeObserver); };
const flushFrames = () => act(() => { for (const frame of frames.splice(0)) frame(0); });

describe('measured connector anchors', () => {
  it('measures track centres and left edges relative to the host and observes the host and every row', () => {
    render(<Host />);
    expect(latest.anchors).toEqual({ a: { y: 72, trackLeft: 240 }, b: { y: 132, trackLeft: 240 } });
    expect(observers.at(-1)?.observed).toHaveLength(3);
  });
  it('draws nothing while any requested anchor is missing or not laid out', () => {
    render(<Host rows={['a']} />);
    expect(latest.anchors).toBeNull();
    layout.b = { top: 160, height: 0 };
    render(<Host />);
    expect(latest.anchors).toBeNull();
  });
  it('batches observer bursts into one frame and publishes changed row positions', () => {
    render(<Host />);
    layout.b = { top: 220, height: 24 };
    deliver(); deliver(); deliver();
    expect(frames).toHaveLength(1);
    expect(latest.anchors?.b?.y).toBe(132);
    flushFrames();
    expect(latest.anchors?.b?.y).toBe(192);
  });
  it('hides old geometry when inputs change and the new layout cannot be measured yet', () => {
    const view = render(<Host />);
    expect(latest.anchors).not.toBeNull();
    layout.a = undefined;
    view.rerender(<Host identity="scope-2" />);
    expect(latest.anchors).toBeNull();
    layout.a = { top: 130, height: 24 };
    deliver(); flushFrames();
    expect(latest.anchors?.a?.y).toBe(102);
  });
  it('ignores a frame queued for an older identity and clears on disable or a replaced host', () => {
    const view = render(<Host />);
    deliver();
    layout.a = undefined;
    view.rerender(<Host identity="scope-2" />);
    flushFrames();
    expect(latest.anchors).toBeNull();
    layout.a = { top: 100, height: 24 };
    view.rerender(<Host identity="scope-1" enabled={false} />);
    expect(latest.anchors).toBeNull();
    expect(observers.every(entry => entry.disconnected)).toBe(true);
    layout.a = undefined;
    view.rerender(<Host identity="scope-1" hostKey="two" />);
    // A remounted chart (e.g. after access was re-confirmed) never reuses the old host's measurement.
    expect(latest.anchors).toBeNull();
  });
});
