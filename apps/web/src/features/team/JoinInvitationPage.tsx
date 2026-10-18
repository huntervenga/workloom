import { useQueryClient } from '@tanstack/react-query';
import { acceptTeamInvitationResultSchema } from '@workloom/contracts';
import { Button, Logomark } from '@workloom/ui';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router';
import { LoginScreen } from '../auth/LoginScreen';
import { useMeQuery } from '../identity/identity';
import { t, useTranslation } from '../../i18n';
import { createIdempotencyKey } from '../../lib/idempotency';
import { queryKeys } from '../../lib/queryKeys';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { invitationHandoff } from './invitationHandoff';
import { prepareAcceptInvitation } from './teamApi';
import { TeamCommandController } from './teamCommandController';

/** Acceptance is explicit, actor-bound and separate from the signed-in workspace shell. */
export function JoinInvitationPage() {
  useTranslation();
  const me = useMeQuery();
  const client = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate); navigateRef.current = navigate;
  const actorId = me.data?.authMode === 'shared' && me.data.actor.kind === 'real' ? me.data.actor.id : '';
  const controller = useMemo(() => new TeamCommandController(client, actorId), [client, actorId]);
  const command = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const handoff = useSyncExternalStore(invitationHandoff.subscribe, invitationHandoff.getSnapshot);
  useEffect(() => controller.attach((result) => {
    const parsed = acceptTeamInvitationResultSchema.safeParse(result);
    if (!parsed.success) return;
    invitationHandoff.clear();
    void client.invalidateQueries({ queryKey: queryKeys.workspaces(actorId), exact: true });
    navigateRef.current(`/w/${parsed.data.workspaceId}/projects`, { replace: true });
  }), [actorId, client, controller]);
  useEffect(() => {
    if (me.isError && 'status' in me.error && me.error.status === 401) invitationHandoff.requireSignIn();
    else if (me.isSuccess && me.data.authMode === 'shared' && me.data.actor.kind === 'real') invitationHandoff.claim(me.data.actor.id);
    else if (me.isSuccess) invitationHandoff.requireSignIn();
  }, [me.isError, me.error, me.isSuccess, me.data]);

  const denied = me.isError && 'status' in me.error && me.error.status === 401;
  if (denied) return <div><JoinNotice /><LoginScreen mode="shared" identityError={me.error} retryingIdentity={me.isFetching} onRetryIdentity={() => void me.refetch()} /></div>;
  if (me.isPending) return <Frame><p role="status">{t('team.join.loading')}</p></Frame>;
  if (me.isError) return <Frame><QueryErrorState error={me.error} subject="identity" retrying={me.isFetching} onRetry={() => void me.refetch()} /></Frame>;
  const eligible = me.data.authMode === 'shared' && me.data.actor.kind === 'real';
  const ready = eligible && handoff === 'ready';
  return <Frame>
    <h1 className="text-xl font-semibold text-ink">{t('team.join.title')}</h1>
    <p className="mt-3 text-sm text-muted">{ready ? t('team.join.description', { name: me.data.actor.displayName }) : t(handoff === 'invalid' ? 'team.join.invalid' : 'team.join.reopen')}</p>
    {ready ? <p className="mt-2 text-sm text-muted">{t('team.join.existingRole')}</p> : null}
    {command.error ? <p role="alert" className="mt-4 text-sm text-danger">{t(command.phase === 'uncertain' ? 'team.command.uncertain' : 'team.command.failed')}</p> : null}
    <div className="mt-6 flex flex-wrap gap-2">
      {ready ? <Button variant="primary" disabled={command.phase !== 'idle'} onClick={() => {
        invitationHandoff.claim(actorId);
        const credential = invitationHandoff.forActor(actorId);
        if (!credential) return;
        controller.execute(prepareAcceptInvitation(credential, actorId, createIdempotencyKey()));
      }}>{command.phase === 'pending' ? t('team.join.joining') : t('team.join.accept')}</Button> : null}
      {command.phase === 'uncertain' ? <Button disabled={!ready} onClick={() => controller.retry()}>{t('team.command.retry')}</Button> : null}
      <Link to="/" className="inline-flex min-h-10 items-center px-3 text-sm text-accent">{t('team.join.back')}</Link>
    </div>
  </Frame>;
}
function Frame({ children }: { children: React.ReactNode }) {
  return <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10"><section className="w-full max-w-md rounded-2xl border border-line bg-surface p-6"><div className="mb-6 flex items-center gap-2"><Logomark className="size-7" /><span className="font-semibold">{t('common.brand')}</span></div>{children}</section></main>;
}
function JoinNotice() { return <p role="note" className="mx-auto max-w-lg px-4 pt-6 text-center text-sm text-muted">{t('team.join.signInFirst')}</p>; }
