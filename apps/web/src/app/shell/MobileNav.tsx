import { t, useTranslation } from '../../i18n';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@workloom/ui';
import { Menu, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

const DESKTOP_QUERY = '(min-width: 64rem)';

/** Sidebar in a modal drawer below the lg breakpoint. Radix returns focus to the trigger. */
export function MobileNav({ children }: { children: (close: () => void) => ReactNode }) {
  useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DESKTOP_QUERY);
    const closeOnDesktop = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener('change', closeOnDesktop);
    return () => media.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" className="-ml-1.5 px-2 lg:hidden" aria-label={t('shell.openMenu')}>
          <Menu size={18} aria-hidden="true" />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl outline-none"
        >
          <Dialog.Title className="sr-only">{t('shell.navigation')}</Dialog.Title>
          <Dialog.Close asChild>
            <Button variant="ghost" size="sm" className="absolute top-3 right-3 z-10 px-2" aria-label={t('shell.closeMenu')}>
              <X size={18} aria-hidden="true" />
            </Button>
          </Dialog.Close>
          {children(() => setOpen(false))}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
