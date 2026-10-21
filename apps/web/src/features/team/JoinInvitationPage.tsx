import { useQueryClient } from '@tanstack/react-query';
import { acceptTeamInvitationResultSchema } from '@workloom/contracts';
import { Button, Logomark } from '@workloom/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useOptionalSession } from '../../app/session';
import { loginHref } from '../auth/authApi';
import { useMeQuery } from '../identity/identity';
import { t, useTranslation } from '../../i18n';
import { ApiError, apiRequest } from '../../lib/api';
import { createIdempotencyKey } from '../../lib/idempotency';
import { queryKeys } from '../../lib/queryKeys';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { invitationHandoff } from './invitationHandoff';
import { prepareAcceptInvitation, prepareResumeInvitation, stageInvitationForSignIn } from './teamApi';
import { TeamCommandController } from './teamCommandController';

/** Links enter only memory; the explicit sign-in action stages a short-lived HttpOnly continuation. */
export function JoinInvitationPage() {
  useTranslation();
  const me = useMeQuery(), session = useOptionalSession(), location = useLocation();
  const client = useQueryClient(), navigate = useNavigate();
  const navigateRef = useRef(navigate); navigateRef.current = navigate;
  const actorId = me.data?.authMode === 'shared' && me.data.actor.kind === 'real' ? me.data.actor.id : '';
  const controller = useMemo(() => new TeamCommandController(client, actorId), [client, actorId]);
  const command = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const handoff = useSyncExternalStore(invitationHandoff.subscribe, invitationHandoff.getSnapshot);
  const [staging, setStaging] = useState(false), [stageError, setStageError] = useState(false), [staged, setStaged] = useState(false);
  const stageFlight = useRef(false), stageOwner = useRef(0), resumedFor = useRef<string | null>(null);
  const resume = new URLSearchParams(location.search).get('resume') === '1' && (handoff === 'empty' || handoff === 'expired');
  useEffect(() => { const owner = ++stageOwner.current; return () => { stageOwner.current = owner + 1; }; }, []);
  useEffect(() => controller.attach((result) => {
    const parsed = acceptTeamInvitationResultSchema.safeParse(result);
    if (!parsed.success) return;
    invitationHandoff.clear();
    void apiRequest('/api/v1/auth/invitation-handoff/clear', { method: 'POST', body: {} }).catch(() => undefined);
    void client.invalidateQueries({ queryKey: queryKeys.workspaces(actorId), exact: true });
    navigateRef.current(`/w/${parsed.data.workspaceId}/projects`, { replace: true });
  }), [actorId, client, controller]);
  useEffect(() => {
    if (me.isError && 'status' in me.error && me.error.status === 401) invitationHandoff.requireSignIn();
    else if (me.isSuccess && me.data.authMode === 'shared' && me.data.actor.kind === 'real') invitationHandoff.claim(me.data.actor.id);
    else if (me.isSuccess) invitationHandoff.requireSignIn();
  }, [me.isError, me.error, me.isSuccess, me.data]);
  // The flag carries no credential. Only a cookie bound to this completed login can authorize resume.
  // Defer one microtask so StrictMode's discarded first effect never starts a detached command.
  useEffect(() => {
    let active = true;
    if (resume && actorId && resumedFor.current !== actorId) queueMicrotask(() => {
      if (!active || resumedFor.current === actorId) return;
      resumedFor.current = actorId;
      controller.execute(prepareResumeInvitation(actorId, createIdempotencyKey()));
    });
    return () => { active = false; };
  }, [resume, actorId, controller]);

  const signInAndJoin = async () => {
    if (stageFlight.current) return;
    const credential = actorId ? invitationHandoff.forActor(actorId) : invitationHandoff.forSignIn();
    if (!credential && !staged && !resume) return;
    const owner = stageOwner.current;
    stageFlight.current = true; setStaging(true); setStageError(false);
    try {
      if (!staged && credential) {
        await stageInvitationForSignIn(credential);
        if (owner !== stageOwner.current) return;
        setStaged(true); invitationHandoff.clear();
      }
      if (session) await session.startSignIn('/app/join');
      else window.location.assign(loginHref('/app/join'));
    } catch { if (owner === stageOwner.current) setStageError(true); }
    finally { if (owner === stageOwner.current) { stageFlight.current = false; setStaging(false); } }
  };
  const denied = me.isError && 'status' in me.error && me.error.status === 401;
  if (denied) return <Frame>
    <h1 className="text-xl font-semibold text-ink">{t('team.join.title')}</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted">{t('team.join.personalSignIn')}</p>
    {stageError ? <p role="alert" className="mt-4 text-sm text-danger">{t('team.join.stageFailed')}</p> : null}
    <div className="mt-6 flex flex-wrap gap-2">
      {invitationHandoff.forSignIn() || staged ? <Button variant="primary" disabled={staging} onClick={() => void signInAndJoin()}>{t(staging ? 'team.join.preparing' : 'team.join.signInAndJoin')}</Button> : <a href={loginHref('/app/join')} className="inline-flex min-h-10 items-center px-3 text-sm text-accent">{t('auth.signIn')}</a>}
      <Link to="/" className="inline-flex min-h-10 items-center px-3 text-sm text-accent">{t('team.join.back')}</Link>
    </div>
  </Frame>;
  if (me.isPending) return <Frame><p role="status">{t('team.join.loading')}</p></Frame>;
  if (me.isError) return <Frame><QueryErrorState error={me.error} subject="identity" retrying={me.isFetching} onRetry={() => void me.refetch()} /></Frame>;
  const eligible = me.data.authMode === 'shared' && me.data.actor.kind === 'real';
  const ready = eligible && handoff === 'ready';
  return <Frame>
    <h1 className="text-xl font-semibold text-ink">{t('team.join.title')}</h1>
    <p className="mt-3 text-sm text-muted">{resume ? t('team.join.resuming') : ready ? t('team.join.description', { name: me.data.actor.displayName }) : t(handoff === 'invalid' ? 'team.join.invalid' : 'team.join.reopen')}</p>
    {ready ? <p className="mt-2 text-sm text-muted">{t('team.join.existingRole')}</p> : null}
    {command.error ? <p role="alert" className="mt-4 text-sm text-danger">{invitationErrorText(command.error, command.phase === 'uncertain')}</p> : null}
    <div className="mt-6 flex flex-wrap gap-2">
      {ready ? <Button variant="primary" disabled={command.phase !== 'idle'} onClick={() => {
        invitationHandoff.claim(actorId);
        const credential = invitationHandoff.forActor(actorId);
        if (!credential) return;
        controller.execute(prepareAcceptInvitation(credential, actorId, createIdempotencyKey()));
      }}>{command.phase === 'pending' ? t('team.join.joining') : t('team.join.accept')}</Button> : null}
      {command.phase === 'uncertain' ? <Button disabled={!eligible} onClick={() => controller.retry()}>{t('team.command.retry')}</Button> : null}
      {command.error && command.phase === 'idle' ? <Button disabled={staging} onClick={() => void signInAndJoin()}>{t('team.join.otherAccount')}</Button> : null}
      {stageError ? <p role="alert" className="text-sm text-danger">{t('team.join.stageFailed')}</p> : null}
      {resume && command.error && command.phase === 'idle' ? <Button onClick={() => controller.execute(prepareResumeInvitation(actorId, createIdempotencyKey()))}>{t('team.join.tryAgain')}</Button> : null}
      <Link to="/" className="inline-flex min-h-10 items-center px-3 text-sm text-accent">{t('team.join.back')}</Link>
    </div>
  </Frame>;
}
export function invitationErrorText(error: Error, uncertain = false): string {
  if (uncertain) return t('team.command.uncertain');
  if (error instanceof ApiError) {
    switch (error.invitationReason) {
      case 'email_unverified': return t('team.join.emailUnverified');
      case 'email_mismatch': return t('team.join.emailMismatch');
      case 'member_conflict': return t('team.join.memberConflict');
      case 'pending_claimed': return t('team.join.alreadyClaimed');
    }
    if (error.kind === 'not_found') return t('team.join.unavailable');
  }
  return t('team.command.failed');
}
function Frame({ children }: { children: React.ReactNode }) {
  return <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10"><section className="w-full max-w-md rounded-2xl border border-line bg-surface p-6"><div className="mb-6 flex items-center gap-2"><Logomark className="size-7" /><span className="font-semibold">{t('common.brand')}</span></div>{children}</section></main>;
}
