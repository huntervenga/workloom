import { useRef, useState, useSyncExternalStore } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Download, LogOut, Settings } from 'lucide-react';
import type { MeDto } from '@workloom/contracts';
import { useSession } from '../../app/session';
import { useTranslation } from '../../i18n';
import { installManager } from '../pwa/install';
import { InstallAppDialog } from '../pwa/InstallAppDialog';
import { UserAvatar } from '../../shared/UserAvatar';

export function ProfileMenu({ me, onSettings }: { me: MeDto; onSettings: () => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const [installOpen, setInstallOpen] = useState(false);
  const installState = useSyncExternalStore(installManager.subscribe, installManager.getSnapshot);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><Menu.Root modal={false}>
    <Menu.Trigger asChild><button ref={trigger} type="button" aria-label={t('profile.menu', { name: me.actor.displayName })} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent">
      <UserAvatar name={me.actor.displayName} avatarUrl={me.actor.avatarUrl} size="sm" />
      <span className="hidden max-w-40 truncate sm:block">{me.actor.displayName}</span><ChevronDown size={14} aria-hidden="true" />
    </button></Menu.Trigger>
    <Menu.Portal><Menu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-lg">
      <Menu.Item className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas" onSelect={() => { trigger.current?.focus(); onSettings(); }}>
        <Settings size={16} aria-hidden="true" />{t('profile.settings')}
      </Menu.Item>
      {!installState.installed ? <Menu.Item className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas" onSelect={() => { trigger.current?.focus(); setInstallOpen(true); }}>
        <Download size={16} aria-hidden="true" />{t('pwa.installTitle')}
      </Menu.Item> : null}
      {me.authMode === 'shared' ? <><Menu.Separator className="my-1 h-px bg-line" />
        <Menu.Item disabled={session.signingOut} className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas data-[disabled]:opacity-50" onSelect={() => { void session.signOut(); }}>
          <LogOut size={16} aria-hidden="true" />{session.signingOut ? t('auth.signingOut') : t('auth.signOut')}
        </Menu.Item></> : null}
    </Menu.Content></Menu.Portal>
  </Menu.Root>
    {installOpen ? <InstallAppDialog onClose={() => setInstallOpen(false)} /> : null}
  </>;
}
