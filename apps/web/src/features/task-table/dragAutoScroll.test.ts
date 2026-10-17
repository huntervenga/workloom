import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeScrollStep, scrollDragEdge } from './dragAutoScroll';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); Reflect.deleteProperty(document, 'scrollingElement'); });
describe('held pointer edge scrolling', () => {
  it('uses bounded velocity only inside the edge band', () => {
    expect(edgeScrollStep(0, 0, 600)).toBe(-18); expect(edgeScrollStep(600, 0, 600)).toBe(18);
    expect(edgeScrollStep(300, 0, 600)).toBe(0); expect(edgeScrollStep(601, 0, 600)).toBe(0);
  });
  it('scrolls the overflowing drawer under the pointer before the page and clamps its extent', () => {
    const port = document.createElement('div'), cell = document.createElement('span'); port.append(cell); document.body.append(port);
    port.style.overflowY = 'auto'; Object.defineProperties(port, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
    vi.spyOn(port, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, left: 0, right: 300 } as DOMRect);
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    expect(scrollDragEdge({ x: 150, y: 495 }, cell)).toBe(true); expect(port.scrollTop).toBeGreaterThan(0); expect(scroll).not.toHaveBeenCalled();
    port.scrollTop = 599; scrollDragEdge({ x: 150, y: 495 }, cell); expect(port.scrollTop).toBe(600);
  });
  it('scrolls the page when no nested scrollport consumes the edge', () => {
    const page = document.createElement('div'); Object.defineProperties(page, { scrollHeight: { value: 3000 }, scrollTop: { value: 100, writable: true } });
    Object.defineProperty(document, 'scrollingElement', { configurable: true, get: () => page });
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation((_x, y) => { page.scrollTop += Number(y); });
    expect(scrollDragEdge({ x: 100, y: window.innerHeight - 1 }, document.body)).toBe(true);
    expect(scroll).toHaveBeenCalledWith(0, 18); expect(page.scrollTop).toBe(118);
  });
});
