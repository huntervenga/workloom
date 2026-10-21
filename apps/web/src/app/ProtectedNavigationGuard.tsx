import type { MeDto, WorkspaceDto } from '@workloom/contracts';
import { queryKeys } from '../lib/queryKeys';
import { canonicalWorkspacePath } from '../features/workspace/workspaceRouting';
import { t, useTranslation } from '../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@workloom/ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';
import { protectedDraftsFor } from '../lib/protectedDrafts';
import { protectedCommandsFor } from '../lib/protectedCommands';
import { useUnsavedChangesWarning } from '../lib/useUnsavedChangesWarning';
import { DialogShell } from '../shared/DialogShell';
import { useSessionAction } from './session';

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
    ({ currentLocation, nextLocation }) => {
      if (!registry.protecting && !drafts.protecting) return false;
      const actorId = client.getQueryData<MeDto>(queryKeys.me)?.actor.id;
      const addressState = actorId ? client.getQueryState<WorkspaceDto[]>(queryKeys.workspaces(actorId)) : undefined;
      const list = addressState?.status === 'success' ? addressState.data ?? [] : [];
      return canonicalWorkspacePath(currentLocation.pathname, list) !== canonicalWorkspacePath(nextLocation.pathname, list);
    },
    [registry,drafts,client],
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
  // Signing in or out asks the same question in its own words; dev switches keep theirs.
  const sessionAction = useSessionAction();
  const auth = asking === 'switch' ? sessionAction : null;
  const title =
    auth === 'signOut' ? t('auth.signOutQuestion') : auth === 'signIn' ? t('auth.signInQuestion') : asking === 'switch' ? t('shell.switchQuestion') : t('shell.leaveQuestion');
  const leaveLabel =
    auth === 'signOut'
      ? protecting ? t('auth.leaveUnconfirmedSignOut') : t('auth.leaveUnsavedSignOut')
      : auth === 'signIn'
        ? protecting ? t('auth.leaveUnconfirmedSignIn') : t('auth.leaveUnsavedSignIn')
        : asking === 'switch' ? protecting ? t('shell.switchUnconfirmed') : t('shell.switchDiscard') : protecting ? t('shell.leaveUnconfirmed') : t('shell.leaveUnsaved');

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
      title={title}
      description={protecting?t('shell.unconfirmed'):t('shell.unsaved')}
      open={asking !== null}
      onOpenChange={(next) => {
        if (!next) stay();
      }}
    >
      <div className="mt-4 space-y-2 text-sm leading-relaxed text-ink-soft">
        {protecting?<><p>{t('shell.mayHaveSaved')}</p>
        <p>
          {t(asking === 'switch' && auth === null ? 'shell.switchRetryHelp' : 'shell.leaveRetryHelp')}
        </p>
        <p>{t('shell.stayToRetry')}</p></>:<p>{t('shell.draftLeaveHelp')}</p>}
      </div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={leave}>{leaveLabel}</Button>
        <Button variant="primary" onClick={stay}>

          {t('shell.stay')}
        </Button>
      </div>
    </DialogShell>
  );
}
