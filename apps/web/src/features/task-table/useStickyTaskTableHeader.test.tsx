import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStickyTaskTableHeader } from './useStickyTaskTableHeader';

let layout: { top: number; bottom: number; naturalHead: number; portTop: number; portHeight: number; shellBottom: number; shellHeight: number };
let frames: Map<number, FrameRequestCallback>, nextFrame: number, resize: (() => void) | undefined;
function box(top: number, bottom: number): DOMRect { return new DOMRect(240, top, 1200, bottom - top); }
function Harness({ revision = 0, shell = true, pinned = false }: { revision?: number; shell?: boolean; pinned?: boolean }) {
  const { scrollRef, headerRef } = useStickyTaskTableHeader();
  return <div className="app-shell-workspace">{shell ? <header>Global controls</header> : null}<main><div data-ancestor=""><div ref={scrollRef} data-scroll=""><table><thead ref={headerRef}><tr><th scope="col" className={pinned ? "task-table-pinned-column" : undefined}><button type="button">Column options</button></th>{pinned ? <th className="task-table-pinned-column">Estimate</th> : null}</tr></thead><tbody><tr><td>{revision}</td></tr></tbody></table></div></div></main></div>;
}
function required<T>(value: T | null): T { if (value === null) throw new Error('Missing sticky heading test element.'); return value; }
const head = () => screen.getByRole('columnheader').closest('thead') as HTMLTableSectionElement;
const visibleTop = () => head().getBoundingClientRect().top;
function flush() { act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(1); }); }
function move(top: number, bottom: number) {
  layout.top = top; layout.bottom = bottom; layout.naturalHead = top; layout.portTop = top; layout.portHeight = bottom - top;
}
beforeEach(() => {
  layout = { top: 250, bottom: 2250, naturalHead: 250, portTop: 250, portHeight: 2000, shellBottom: 56, shellHeight: 56 };
  frames = new Map(); nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-scroll') ? layout.portHeight : 0; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName === 'THEAD') { const y = Number.parseFloat(this.style.translate.split(' ')[1] ?? '0'); return box(layout.naturalHead + y, layout.naturalHead + y + 36); }
    if (this.tagName === 'TABLE') return box(layout.top, layout.bottom);
    if (this.tagName === 'HEADER') return box(layout.shellBottom - layout.shellHeight, layout.shellBottom);
    if (this.hasAttribute('data-scroll')) return box(layout.portTop, layout.portTop + layout.portHeight);
    return box(0, 0);
  });
});
afterEach(() => { vi.restoreAllMocks(); resize = undefined; });

describe('genuine task heading viewport positioning', () => {
  it('leaves the normal heading untouched, pins below Topbar on page scroll and returns to its original place', () => {
    render(<Harness />); flush(); expect(visibleTop()).toBe(250); expect(head().style.translate).toBe('');
    move(-300, 1700); fireEvent.scroll(window); flush();
    expect(visibleTop()).toBe(56); expect(head()).toHaveAttribute('data-task-table-header-stuck');
    fireEvent.scroll(window); flush(); expect(visibleTop()).toBe(56); // No cumulative feedback from the transformed rectangle.
    expect(screen.getAllByRole('columnheader')).toHaveLength(1); expect(screen.getByRole('button', { name: 'Column options' })).toBeEnabled();
    move(250, 2250); fireEvent.scroll(window); flush(); expect(visibleTop()).toBe(250); expect(head().style.translate).toBe('');
    expect(head()).not.toHaveAttribute('data-task-table-header-stuck');
  });
  it('never paints below the table bottom, including short/collapsed content', () => {
    move(-1000, 78); render(<Harness />); flush(); expect(visibleTop()).toBe(42); expect(head().getBoundingClientRect().bottom).toBe(78);
    move(-1000, 25); act(() => resize?.()); flush(); expect(head().getBoundingClientRect().bottom).toBe(25);
  });
  it('reacts to captured ancestor scrolling and layout/column changes without changing focus or scroll positions', () => {
    const result = render(<Harness />); flush(); const button = screen.getByRole('button', { name: 'Column options' }); button.focus();
    const port = required(document.querySelector<HTMLElement>('[data-scroll]')); port.scrollLeft = 150;
    move(-120, 1880); fireEvent.scroll(required(document.querySelector('[data-ancestor]'))); flush(); expect(visibleTop()).toBe(56);
    layout.shellBottom = 72; fireEvent(window, new Event('resize')); flush(); expect(visibleTop()).toBe(72);
    move(-140, 1860); result.rerender(<Harness revision={1} />); flush(); expect(visibleTop()).toBe(72);
    expect(button).toHaveFocus(); expect(port.scrollLeft).toBe(150);
  });
  it('keeps native pinning inside a vertically constrained port and stops at its clipping edge', () => {
    layout.top = -200; layout.bottom = 1800; layout.portTop = 140; layout.portHeight = 500; layout.naturalHead = 140;
    render(<Harness />); flush(); expect(visibleTop()).toBe(140); expect(head().style.translate).toBe('');
    layout.portTop = -50; layout.portHeight = 120; layout.naturalHead = -50; fireEvent.scroll(window); flush();
    expect(visibleTop()).toBe(34); expect(head().getBoundingClientRect().bottom).toBe(70);
  });
  it('unpins wide edges to keep neighboring columns accessible and restores pinning when space returns', () => {
    const ui = render(<Harness pinned />);
    const port = required(document.querySelector<HTMLElement>('[data-scroll]'));
    const title = screen.getByRole('columnheader', { name: 'Column options' }), estimate = screen.getByRole('columnheader', { name: 'Estimate' });
    let available = 900, titleWidth = 450, estimateWidth = 128;
    vi.spyOn(port, 'clientWidth', 'get').mockImplementation(() => available);
    Object.defineProperty(title, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, titleWidth, 36) });
    Object.defineProperty(estimate, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, estimateWidth, 36) });
    const check = (unpinned: boolean) => {
      fireEvent(window, new Event('resize')); flush();
      expect(port.hasAttribute('data-task-table-unpinned')).toBe(unpinned);
    };
    check(false);
    titleWidth = 800; check(true);
    titleWidth = 450; estimateWidth = 400; check(true);
    estimateWidth = 128; available = 500; check(true);
    available = 1000; check(false);
    available = 500; check(true);
    ui.unmount(); expect(port).not.toHaveAttribute('data-task-table-unpinned');
  });
  it('pins at the viewport top without a shell, batches events and cancels work on unmount', () => {
    const result = render(<Harness shell={false} />); flush(); move(-150, 1850);
    fireEvent.scroll(window); fireEvent.scroll(window); fireEvent(window, new Event('resize')); expect(frames.size).toBe(1);
    flush(); expect(visibleTop()).toBe(0); const original = head();
    fireEvent.scroll(window); expect(frames.size).toBe(1); result.unmount(); expect(frames.size).toBe(0); expect(original.style.translate).toBe('');
    fireEvent.scroll(window); expect(frames.size).toBe(0);
  });
});
