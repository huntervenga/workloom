import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';
import { useTranslation } from '../../i18n';
const subscribe = (listener: () => void) => {
  window.addEventListener('online', listener); window.addEventListener('offline', listener);
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
};
export function AppConnectionNotice() {
  const { t } = useTranslation();
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  return online ? null : <div role="status" className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-surface p-3 text-sm text-ink-soft"><WifiOff size={18} className="shrink-0" aria-hidden="true" />{t('pwa.offlineNotice')}</div>;
}
