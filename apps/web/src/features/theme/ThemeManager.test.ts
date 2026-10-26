import { describe, expect, it, vi } from 'vitest';
import { createThemeManager, type ThemeEnvironment } from './ThemeManager';

function browser(dark = false) {
  const doc = document.implementation.createHTMLDocument('theme');
  let systemDark = dark;
  const listeners = new Set<() => void>();
  const query = { get matches() { return systemDark; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) } as unknown as MediaQueryList;
  const env: ThemeEnvironment = { document: doc, matchMedia: () => query };
  Object.defineProperty(env, 'localStorage', { get() { throw Error('Theme must not use local storage'); } });
  return { doc, env, listeners, system(value: boolean) { systemDark = value; for (const fn of listeners) fn(); } };
}

describe('server-controlled theme presentation', () => {
  it('uses the original palettes for Default and follows changes to the system', () => {
    const b = browser(), manager = createThemeManager(b.env); const stop = manager.start();
    expect(manager.getChoice()).toBe('default'); expect(manager.getTheme()).toBe('light');
    b.system(true); expect(b.doc.documentElement.dataset.theme).toBe('default-dark');
    expect(b.doc.documentElement.style.colorScheme).toBe('dark');
    b.system(false); expect(manager.getTheme()).toBe('light'); stop(); expect(b.listeners.size).toBe(0);
  });
  it('applies explicit server settings independently of the system and without storage', () => {
    const b = browser(true), manager = createThemeManager(b.env); manager.start();
    const changed = vi.fn(); const unsubscribe = manager.subscribe(changed);
    manager.setTheme('dark'); expect(b.doc.documentElement.dataset.theme).toBe('dark');
    b.system(false); expect(manager.getTheme()).toBe('dark');
    manager.setTheme('light'); b.system(true); expect(manager.getTheme()).toBe('light');
    manager.setTheme('default'); expect(manager.getTheme()).toBe('default-dark');
    expect(changed).toHaveBeenCalledTimes(3); unsubscribe();
  });
  it('does not carry a saved choice into a fresh page and handles missing browser APIs', () => {
    const first = createThemeManager(null); first.setTheme('dark');
    expect(createThemeManager(null).getChoice()).toBe('default');
    const manager = createThemeManager({ matchMedia: () => { throw Error('Unsupported'); } });
    expect(() => manager.start()()).not.toThrow(); expect(manager.getTheme()).toBe('light');
    manager.setTheme('unknown' as never); expect(manager.getChoice()).toBe('default');
  });
});
