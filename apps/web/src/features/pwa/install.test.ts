import { describe, expect, it, vi } from 'vitest';
import { createInstallManager, type InstallPromptEvent } from './install';
function harness(standalone = false) {
  const browser = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: standalone });
  Object.assign(browser, { navigator: {}, matchMedia: () => media });
  const manager = createInstallManager(browser as unknown as Window);
  manager.start();
  const offer = (choice: Promise<{ outcome: 'accepted' | 'dismissed' }> = Promise.resolve({ outcome: 'dismissed' })) => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    event.prompt = vi.fn(async () => {}); event.userChoice = choice;
    browser.dispatchEvent(event); return event;
  };
  return { browser, media, manager, offer };
}
describe('PWA installation', () => {
  it('keeps a deferred prompt until a user action, consumes it once, and permits a later offer', async () => {
    const h = harness(); const first = h.offer();
    expect(first.defaultPrevented).toBe(true); expect(first.prompt).not.toHaveBeenCalled();
    expect(h.manager.getSnapshot().available).toBe(true);
    await h.manager.install(); await h.manager.install();
    expect(first.prompt).toHaveBeenCalledTimes(1); expect(h.manager.getSnapshot().available).toBe(false);
    const next = h.offer(); await h.manager.install(); expect(next.prompt).toHaveBeenCalledTimes(1);
  });
  it('does not equate accepting the prompt with a completed install', async () => {
    const h = harness(); h.offer(Promise.resolve({ outcome: 'accepted' })); await h.manager.install();
    expect(h.manager.getSnapshot().installed).toBe(false);
    h.browser.dispatchEvent(new Event('appinstalled'));
    expect(h.manager.getSnapshot()).toMatchObject({ installed: true, available: false });
  });
  it('handles failed prompts and display mode changes', async () => {
    const h = harness(); const event = h.offer(); event.prompt = vi.fn().mockRejectedValue(new Error('unavailable'));
    await h.manager.install(); expect(h.manager.getSnapshot()).toMatchObject({ failed: true, prompting: false });
    h.media.matches = true; h.media.dispatchEvent(new Event('change'));
    expect(h.manager.getSnapshot().installed).toBe(true);
  });
  it('detects standalone launches and does not double-register listeners', () => {
    const h = harness(true); expect(h.manager.getSnapshot().installed).toBe(true);
    const listener = vi.fn(); const unsubscribe = h.manager.subscribe(listener);
    const stop = h.manager.start(); stop(); h.offer(); expect(listener).not.toHaveBeenCalled(); unsubscribe();
    expect(() => createInstallManager(null).start()()).not.toThrow();
  });
});
