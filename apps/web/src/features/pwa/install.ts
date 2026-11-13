/** Chromium's install event is deliberately kept in memory and used only after a user gesture. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export interface InstallState { available: boolean; installed: boolean; prompting: boolean; failed: boolean }
export function createInstallManager(browser: Window | null) {
  let pending: InstallPromptEvent | null = null;
  let state: InstallState = { available: false, installed: false, prompting: false, failed: false };
  let stop: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<InstallState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (!browser || stop) return stop ?? (() => {});
      const media = browser.matchMedia?.('(display-mode: standalone)');
      const standalone = () => Boolean(media?.matches || (browser.navigator as Navigator & { standalone?: boolean }).standalone);
      const changed = () => publish({ installed: standalone() });
      const before = (event: Event) => { event.preventDefault(); pending = event as InstallPromptEvent; publish({ available: true, failed: false }); };
      const installed = () => { pending = null; publish({ available: false, installed: true, prompting: false }); };
      changed();
      browser.addEventListener('beforeinstallprompt', before);
      browser.addEventListener('appinstalled', installed);
      media?.addEventListener('change', changed);
      stop = () => {
        browser.removeEventListener('beforeinstallprompt', before);
        browser.removeEventListener('appinstalled', installed);
        media?.removeEventListener('change', changed);
        stop = null;
      };
      return stop;
    },
    async install() {
      if (!pending || state.prompting || state.installed) return;
      const event = pending;
      pending = null;
      publish({ prompting: true, failed: false });
      try {
        await event.prompt();
        // Acceptance starts installation; only appinstalled proves it completed.
        await event.userChoice;
        publish({ available: pending !== null, prompting: false });
      } catch {
        publish({ available: pending !== null, prompting: false, failed: true });
      }
    },
  };
}
export const installManager = createInstallManager(typeof window === 'undefined' ? null : window);

/** No page or API caching; only a public reconnect page. Keep auth callbacks outside worker handling. */
export function registerAppWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext || window.location.pathname.startsWith('/app/auth/')) return;
  const register = () => { void navigator.serviceWorker.register('/app/sw.js', { scope: '/app/', updateViaCache: 'none' }).catch(() => { /* Installation still works without offline support. */ }); };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
