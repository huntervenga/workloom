import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as I18n from '../../i18n';
import type { LocalizationManager, TranslationCatalog } from '../../i18n';
import type { GraphCanvasTask } from './GraphNodeContent';
import { useGraphNodeSizes } from './useGraphNodeSizes';
const state = vi.hoisted(() => ({ manager: null as LocalizationManager | null }));
vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18n>();
  const resources = import.meta.glob<TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const en = Object.fromEntries(Object.entries(resources).map(([path, catalog]) => [path.slice(path.lastIndexOf('/') + 1).replace('.json', ''), catalog]));
  const manager = new actual.LocalizationManager({ en, fr: { dependencies: { graphBlockers: { view: 'Afficher tous les prédécesseurs non terminés ({{count}})' } } } });
  state.manager = manager;
  return { ...actual, useTranslation: () => actual.useTranslation(manager) };
});
const task: GraphCanvasTask = { id: 'a', title: 'Full '.repeat(100), projectName: 'Project '.repeat(20), statusName: 'Stored status', blocked: true, unresolvedCount: 3, archived: true };
let latest: ReturnType<typeof useGraphNodeSizes>;
function Host({ tasks = [task], scope = 'actor:workspace:project:roots:depth:seq', enabled = true }: { tasks?: readonly GraphCanvasTask[]; scope?: string; enabled?: boolean }) {
  latest = useGraphNodeSizes(tasks, scope, enabled);
  return <>{latest.measurementHost}</>;
}
let height = 190;
let observers: { callback: ResizeObserverCallback; observer: ResizeObserver; disconnected: boolean }[];
let restoreRect: () => void;
beforeEach(() => {
  height = 190; observers = [];
  act(() => state.manager?.setLocale('en'));
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-graph-measure-node') ? new DOMRect(0, 0, 240, height) : originalRect.call(this);
  });
  restoreRect = () => spy.mockRestore();
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, observer: this as unknown as ResizeObserver, disconnected: false }; observers.push(this.entry); }
    observe() { /* The test delivers measured browser events explicitly. */ }
    unobserve() { /* No browser layout in jsdom. */ }
    disconnect() { this.entry.disconnected = true; }
  });
});
afterEach(() => restoreRect());
const deliver = (index = observers.length - 1) => { const entry = observers[index]; if (!entry) throw new Error('Missing observer'); entry.callback([], entry.observer); };

describe('current-scope unscaled graph node measurement', () => {
  it('treats an authorized empty node set as measured without mounting a host or leaving a pending state', () => {
    const view = render(<Host tasks={[]} />);
    expect(latest.sizes).toEqual({}); expect(view.container).toBeEmptyDOMElement(); expect(observers).toHaveLength(0);
  });
  it('renders full content in an inert hidden host with the shared box model and no public controls or IDs', () => {
    const view = render(<Host />);
    const host = view.container.querySelector('[data-graph-measurement-host]');
    expect(host).toHaveAttribute('aria-hidden', 'true'); expect(host).toHaveAttribute('inert');
    expect(host).toHaveStyle({ visibility: 'hidden', position: 'fixed', height: '0px', overflow: 'hidden' });
    expect(host).toHaveTextContent(task.title.trim()); expect(host).toHaveTextContent(task.projectName.trim());
    expect(host?.querySelector('[id]')).toBeNull(); expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(host?.querySelector('button')?.tabIndex).toBe(-1);
    expect(host?.querySelector('[data-graph-measure-node]')).toHaveStyle({ width: '240px', minHeight: '128px', padding: '10px', borderWidth: '1px', boxSizing: 'border-box' });
    expect(latest.sizes).toEqual({ a: { width: 240, height: 190 } });
  });
  it('publishes only actual size changes, including observer and viewport/font-related resize', () => {
    render(<Host />); const initial = latest.sizes;
    act(() => deliver()); expect(latest.sizes).toBe(initial);
    height = 244; act(() => deliver()); expect(latest.sizes).toEqual({ a: { width: 240, height: 244 } });
    const changed = latest.sizes; act(() => window.dispatchEvent(new Event('resize'))); expect(latest.sizes).toBe(changed);
    height = 280; act(() => window.dispatchEvent(new Event('resize'))); expect(latest.sizes?.a?.height).toBe(280);
  });
  it('invalidates scope/content/locale measurements immediately and ignores callbacks from replaced owners', () => {
    const view = render(<Host />); const originalIdentity = latest.identity;
    height = 0; view.rerender(<Host scope="another actor:workspace:project:roots:depth:seq" />);
    expect(latest.sizes).toBeNull(); expect(observers[0]?.disconnected).toBe(true);
    height = 222; act(() => deliver(0)); expect(latest.sizes).toBeNull();
    act(() => deliver()); expect(latest.sizes?.a?.height).toBe(222);
    height = 0; view.rerender(<Host scope="another actor:workspace:project:roots:depth:seq" tasks={[{ ...task, title: 'Updated task title', projectName: 'Updated context' }]} />);
    expect(latest.sizes).toBeNull(); height = 300; act(() => deliver()); expect(latest.sizes?.a?.height).toBe(300);
    height = 0; act(() => state.manager?.setLocale('fr')); expect(latest.sizes).toBeNull(); expect(latest.identity).not.toBe(originalIdentity);
    expect(view.container).toHaveTextContent('Afficher tous les prédécesseurs');
    height = 330; act(() => deliver()); expect(latest.sizes?.a?.height).toBe(330);
  });
  it('cleans up stale observer and font-ready callbacks after disabling or unmounting', async () => {
    let resolve: () => void = () => undefined;
    const ready = new Promise<void>(done => { resolve = done; });
    const fonts = Object.assign(new EventTarget(), { ready });
    const previous = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      const view = render(<Host />); height = 250;
      act(() => fonts.dispatchEvent(new Event('loadingdone'))); expect(latest.sizes?.a?.height).toBe(250);
      view.rerender(<Host enabled={false} />); expect(latest.sizes).toBeNull(); expect(view.container).toBeEmptyDOMElement();
      height = 500; act(() => deliver(0)); await act(async () => resolve()); expect(latest.sizes).toBeNull();
      view.unmount(); act(() => fonts.dispatchEvent(new Event('loadingdone'))); expect(observers.every(entry => entry.disconnected)).toBe(true);
    } finally { if (previous) Object.defineProperty(document, 'fonts', previous); else Reflect.deleteProperty(document, 'fonts'); }
  });
});
