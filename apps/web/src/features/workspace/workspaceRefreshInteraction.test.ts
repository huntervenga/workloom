import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { isWorkspaceRefreshProtected, observeWorkspaceRefreshInteraction } from './workspaceRefreshInteraction';

afterEach(() => { document.body.replaceChildren(); });

describe('workspace refresh editing protection', () => {
  it.each(['task draft', 'hours draft', 'field draft', 'collapsed quick-create queue', 'pending write', 'unknown write'])(
    'protects a retained %s even with no mounted editor', label => {
      const client = new QueryClient();
      const registry = label.endsWith('write') ? protectedCommandsFor(client) : protectedDraftsFor(client);
      const slot = registry.register(); slot.set(true);
      expect(isWorkspaceRefreshProtected(client, false)).toBe(true);
      slot.set(false); expect(isWorkspaceRefreshProtected(client, false)).toBe(false);
      client.clear();
    },
  );

  it.each(['input', 'textarea', 'select', 'div'] as const)('protects a pristine focused %s without touching its value/selection/scroll', tag => {
    const client = new QueryClient(); const control = document.createElement(tag);
    control.tabIndex = 0; if (tag === 'div') control.setAttribute('contenteditable', 'true');
    document.body.append(control); control.focus();
    if (control instanceof HTMLInputElement) { control.value = 'exact draft'; control.setSelectionRange(2, 5); }
    document.documentElement.scrollTop = 321;
    expect(isWorkspaceRefreshProtected(client, false)).toBe(true); expect(document.activeElement).toBe(control);
    if (control instanceof HTMLInputElement) expect([control.value, control.selectionStart, control.selectionEnd]).toEqual(['exact draft', 2, 5]);
    expect(document.documentElement.scrollTop).toBe(321);
    control.blur(); expect(isWorkspaceRefreshProtected(client, false)).toBe(false); client.clear();
  });

  it.each(['dialog', 'alertdialog', 'menu', 'listbox'] as const)('protects an open %s, and ignores it when hidden', role => {
    const client = new QueryClient(); const surface = document.createElement('div'); surface.setAttribute('role', role);
    document.body.append(surface); expect(isWorkspaceRefreshProtected(client, false)).toBe(true);
    surface.hidden = true; expect(isWorkspaceRefreshProtected(client, false)).toBe(false); client.clear();
  });

  it('protects IME composition independently of focus', () => {
    const client = new QueryClient(); expect(isWorkspaceRefreshProtected(client, true)).toBe(true);
    expect(isWorkspaceRefreshProtected(client, false)).toBe(false); client.clear();
  });

  it('subscribes to collapsed registry, focus and portal release transitions and cleans up', async () => {
    const client = new QueryClient(); const wake = vi.fn(); const stop = observeWorkspaceRefreshInteraction(client, wake);
    const slot = protectedDraftsFor(client).register(); slot.set(true); await Promise.resolve();
    expect(wake).toHaveBeenCalled(); wake.mockClear(); slot.set(false); await Promise.resolve();
    expect(wake).toHaveBeenCalled(); wake.mockClear();
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
    await Promise.resolve(); await Promise.resolve(); expect(wake).toHaveBeenCalled();
    wake.mockClear(); menu.remove(); await Promise.resolve(); await Promise.resolve(); expect(wake).toHaveBeenCalled();
    stop(); wake.mockClear(); slot.set(true); await Promise.resolve(); expect(wake).not.toHaveBeenCalled(); client.clear();
  });
});
