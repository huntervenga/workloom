import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@workloom/ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';
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
  const registry = protectedCommandsFor(useQueryClient());
  const protecting = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const [switchRequest, setSwitchRequest] = useState<((leave: boolean) => void) | null>(null);

  // Read at navigation time, not from render, so a command started a moment ago counts.
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => registry.protecting && currentLocation.pathname !== nextLocation.pathname,
    [registry],
  );
  const blocker = useBlocker(shouldBlock);
  useUnsavedChangesWarning(protecting);

  useEffect(() => {
    let answer: ((leave: boolean) => void) | null = null;
    const uninstall = registry.setConfirmer(
      () =>
        new Promise<boolean>((resolve) => {
          answer?.(false);
          answer = resolve;
          setSwitchRequest(() => resolve);
        }),
    );
    return () => {
      uninstall();
      // Never leave a switch waiting on a dialog that is gone.
      answer?.(false);
    };
  }, [registry]);

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
      title={asking === 'switch' ? 'Сменить пользователя?' : 'Уйти со страницы?'}
      description="Отправленное изменение ещё не подтверждено сервером."
      open={asking !== null}
      onOpenChange={(next) => {
        if (!next) stay();
      }}
    >
      <div className="mt-4 space-y-2 text-sm leading-relaxed text-ink-soft">
        <p>Сервер мог уже сохранить это изменение, а мог и не получить его.</p>
        <p>
          Если {asking === 'switch' ? 'сменить пользователя' : 'уйти'}, данные для повторной отправки будут сброшены и
          повторить её без риска дубля не получится. Прежде чем создавать что-то заново, проверьте, что уже сохранено.
        </p>
        <p>Чтобы ничего не потерять, останьтесь и дождитесь ответа или повторите отправку.</p>
      </div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={leave}>{asking === 'switch' ? 'Сменить без подтверждения' : 'Уйти без подтверждения'}</Button>
        <Button variant="primary" onClick={stay}>
          Остаться
        </Button>
      </div>
    </DialogShell>
  );
}
