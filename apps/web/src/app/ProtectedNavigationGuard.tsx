import { t, useTranslation } from '../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@workloom/ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';
import { protectedDraftsFor } from '../lib/protectedDrafts';
import { protectedCommandsFor } from '../lib/protectedCommands';
import { useUnsavedChangesWarning } from '../lib/useUnsavedChangesWarning';
import { DialogShell } from '../shared/DialogShell';

/**
 * Asks before anything discards a write that is still being sent or has an unknown outcome:
 * leaving the page within the app (links, `navigate()`, browser back), reloading or closing the
 * tab, and an explicit dev actor switch. Stays mounted while forms and dialogs come and go, so a
 * command kept by a closed dialog is covered too. Needs a data router for `useBlocker`.
 */
export function ProtectedNavigationGuard() {
  useTranslation();
  const client=useQueryClient();
  const registry = protectedCommandsFor(client);
  const drafts=protectedDraftsFor(client);
  const dirty=useSyncExternalStore(drafts.subscribe,drafts.getSnapshot);
  const protecting = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const [switchRequest, setSwitchRequest] = useState<((leave: boolean) => void) | null>(null);

  // Read at navigation time, not from render, so a command started a moment ago counts.
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => (registry.protecting || drafts.protecting) && currentLocation.pathname !== nextLocation.pathname,
    [registry,drafts],
  );
  const blocker = useBlocker(shouldBlock);
  useUnsavedChangesWarning(protecting||dirty);

  useEffect(() => {
    let answer: ((leave: boolean) => void) | null = null;
    const confirm = () =>
        new Promise<boolean>((resolve) => {
          answer?.(false);
          answer = resolve;
          setSwitchRequest(() => resolve);
        });
    const uninstall = registry.setConfirmer(confirm);
    const uninstallDrafts=drafts.setConfirmer(confirm);
    return () => {
      uninstall();
      uninstallDrafts();
      // Never leave a switch waiting on a dialog that is gone.
      answer?.(false);
    };
  }, [registry,drafts]);

  const asking = blocker.state === 'blocked' ? 'route' : switchRequest ? 'switch' : null;

  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset();
    switchRequest?.(false);
    setSwitchRequest(null);
  };
  const leave = () => {
    if (blocker.state === 'blocked') blocker.proceed();
    switchRequest?.(true);
    setSwitchRequest(null);
  };

  return (
    <DialogShell
      title={asking === 'switch' ? t('shell.switchQuestion') : t('shell.leaveQuestion')}
      description={protecting?t('shell.unconfirmed'):t('shell.unsaved')}
      open={asking !== null}
      onOpenChange={(next) => {
        if (!next) stay();
      }}
    >
      <div className="mt-4 space-y-2 text-sm leading-relaxed text-ink-soft">
        {protecting?<><p>{t('shell.mayHaveSaved')}</p>
        <p>
          {t(asking === 'switch' ? 'shell.switchRetryHelp' : 'shell.leaveRetryHelp')}
        </p>
        <p>{t('shell.stayToRetry')}</p></>:<p>{t('shell.draftLeaveHelp')}</p>}
      </div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={leave}>{asking === 'switch' ? protecting?t('shell.switchUnconfirmed'):t('shell.switchDiscard') : protecting?t('shell.leaveUnconfirmed'):t('shell.leaveUnsaved')}</Button>
        <Button variant="primary" onClick={stay}>

          {t('shell.stay')}
        </Button>
      </div>
    </DialogShell>
  );
}
