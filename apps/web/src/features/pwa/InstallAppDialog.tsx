import { useSyncExternalStore } from 'react';
import { Check, Download, MonitorSmartphone, Share, Wifi } from 'lucide-react';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { installManager } from './install';

export function InstallAppDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(installManager.subscribe, installManager.getSnapshot);
  return <DialogShell open title={t('pwa.installTitle')} description={t('pwa.installDescription')} onOpenChange={open => { if (!open) onClose(); }}>
    <div className="mt-5 space-y-5">
      <div className="flex items-center gap-4 rounded-2xl border border-line bg-canvas p-4">
        <img src="/icons/workloom.svg" alt="" width={72} height={72} className="size-18 shrink-0 drop-shadow-md" />
        <div className="min-w-0"><p className="text-lg font-semibold tracking-tight text-ink">{t('common.brand')}</p><p className="mt-1 text-sm leading-relaxed text-muted">{t('pwa.tagline')}</p></div>
      </div>
      <ul className="space-y-3 text-sm text-ink-soft">
        <li className="flex gap-3"><MonitorSmartphone size={18} className="shrink-0 text-accent-ink" aria-hidden="true" />{t('pwa.windowBenefit')}</li>
        <li className="flex gap-3"><Check size={18} className="shrink-0 text-accent-ink" aria-hidden="true" />{t('pwa.accountBenefit')}</li>
        <li className="flex gap-3"><Wifi size={18} className="shrink-0 text-muted" aria-hidden="true" />{t('pwa.connectionBenefit')}</li>
      </ul>
      {state.installed ? <p role="status" className="rounded-xl bg-accent-soft p-3 text-sm text-accent-ink">{t('pwa.installed')}</p> : state.available ? <Button variant="primary" className="h-11 w-full" disabled={state.prompting} onClick={() => { void installManager.install(); }}><Download size={18} aria-hidden="true" />{state.prompting ? t('pwa.installing') : t('pwa.installAction')}</Button> : <div className="space-y-3 rounded-xl border border-line p-4 text-sm text-ink-soft">
        <p className="flex items-center gap-2 font-medium text-ink"><Share size={16} aria-hidden="true" />{t('pwa.manualTitle')}</p>
        <p className="leading-relaxed">{t('pwa.iosInstructions')}</p>
        <p className="leading-relaxed">{t('pwa.browserInstructions')}</p>
      </div>}
      {state.failed ? <p role="alert" className="text-sm text-ink">{t('pwa.installFailed')}</p> : null}
    </div>
  </DialogShell>;
}
