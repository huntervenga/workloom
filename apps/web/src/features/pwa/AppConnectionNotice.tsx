import { useEffect, useState, useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';
import { useTranslation } from '../../i18n';

/** Any answer from the app's own server, whatever its status, means the connection works. */
export const CONNECTION_PROBE_URL = '/healthz/live';
export const CONNECTION_RECHECK_MS = 15_000;
export const CONNECTION_PROBE_TIMEOUT_MS = 5_000;

const subscribe = (listener: () => void) => {
  window.addEventListener('online', listener); window.addEventListener('offline', listener);
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
};

/**
 * A browser can keep reporting offline after the network is back (an installed phone app after sleep or a
 * Wi-Fi/cellular switch, some VPNs) while loads and saves keep working. So while it says offline, the server is
 * asked first, again every few seconds and whenever the app returns to the foreground; only a server that cannot
 * be reached counts as offline.
 */
function useServerUnreachable(browserOffline: boolean): boolean {
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!browserOffline) return undefined;
    let current: AbortController | null = null;
    let disposed = false;
    const probe = async () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const timeout = window.setTimeout(() => controller.abort(), CONNECTION_PROBE_TIMEOUT_MS);
      let reached = false;
      try {
        await fetch(CONNECTION_PROBE_URL, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        reached = true;
      } catch { /* No answer: a network error, or no reply before the timeout. */ } finally { window.clearTimeout(timeout); }
      if (!disposed && current === controller) setUnreachable(!reached);
    };
    // A background tab or a sleeping phone app is not probed; it is asked again when it comes back.
    const recheck = () => { if (document.visibilityState !== 'hidden') void probe(); };
    void probe();
    const interval = window.setInterval(recheck, CONNECTION_RECHECK_MS);
    document.addEventListener('visibilitychange', recheck); window.addEventListener('focus', recheck);
    return () => {
      disposed = true;
      current?.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', recheck); window.removeEventListener('focus', recheck);
      // The next offline report starts unknown, so an old failure never flashes before its own probe answers.
      setUnreachable(false);
    };
  }, [browserOffline]);
  return browserOffline && unreachable;
}

export function AppConnectionNotice() {
  const { t } = useTranslation();
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  const offline = useServerUnreachable(!online);
  return offline ? <div role="status" className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-surface p-3 text-sm text-ink-soft"><WifiOff size={18} className="shrink-0" aria-hidden="true" />{t('pwa.offlineNotice')}</div> : null;
}
