import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import englishTheme from '../../i18n/locales/en/theme.json';
import { t } from '../../i18n';
import { createThemeManager, THEME_STORAGE_KEY, type ThemeManager } from './ThemeManager';
import { ThemeToggle } from './ThemeToggle';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});

function managerWithStore() {
  const store = new Map<string, string>();
  const manager = createThemeManager({
    document,
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } },
  });
  manager.start();
  return { manager, store };
}

/** Counts live store subscriptions, so StrictMode double effects would show up as leaks. */
function counted(manager: ThemeManager) {
  const live = { count: 0 };
  return {
    live,
    manager: {
      ...manager,
      subscribe(listener: () => void) {
        live.count += 1;
        const unsubscribe = manager.subscribe(listener);
        return () => { live.count -= 1; unsubscribe(); };
      },
    } satisfies ThemeManager,
  };
}

let mounts = 0;
function Draft() {
  // Mount counter: a remount after a theme change would bump it.
  const [id] = useState(() => (mounts += 1));
  return <input aria-label="draft" data-mount={id} />;
}

function mount(manager: ThemeManager) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<StrictMode><Draft /><ThemeToggle manager={manager} /></StrictMode>));
  const button = host.querySelector('button');
  if (!button) throw new Error('Expected the theme button');
  return button;
}

describe('ThemeToggle', () => {
  it('uses the localized theme copy', () => {
    const { manager } = managerWithStore();
    const button = mount(manager);
    expect(t('theme.label')).toBe(englishTheme.label);
    expect(button.getAttribute('aria-label')).toBe(englishTheme.label);
    expect(button.title).toBe(englishTheme.toDark);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.type).toBe('button');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('toggles the real root and storage without remounting neighbors, losing a draft, or moving focus', () => {
    const { manager, store } = managerWithStore();
    const button = mount(manager);
    const draft = host?.querySelector('input');
    if (!draft) throw new Error('Expected the draft input');
    const mountId = draft.dataset.mount;
    draft.value = 'unsent text';
    button.focus();

    act(() => button.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect([...store.keys()]).toEqual([THEME_STORAGE_KEY]);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe(englishTheme.toLight);

    expect(host?.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(host?.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('unsent text');
    expect(draft.dataset.mount).toBe(mountId);

    act(() => button.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(store.get(THEME_STORAGE_KEY)).toBe('light');
    expect(document.activeElement).toBe(button);
  });

  it('works from the keyboard as a native button', () => {
    const { manager } = managerWithStore();
    const button = mount(manager);
    button.focus();
    // Enter and Space on a native <button> dispatch click; the element has no custom key handling.
    expect(button.tagName).toBe('BUTTON');
    expect(button.hasAttribute('tabindex')).toBe(false);
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    expect(manager.getTheme()).toBe('dark');
    expect(document.activeElement).toBe(button);
  });

  it('follows changes made elsewhere, such as another tab, and keeps one subscription under StrictMode', () => {
    const { manager: base } = managerWithStore();
    const { manager, live } = counted(base);
    const button = mount(manager);
    expect(live.count).toBe(1);
    act(() => base.setTheme('dark'));
    expect(button.getAttribute('aria-pressed')).toBe('true');
    act(() => root?.unmount());
    root = null;
    expect(live.count).toBe(0);
  });
});
