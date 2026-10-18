import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type TeamInviteRole, type TeamMembershipDto, type WorkspaceDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useMe } from '../identity/identity';
import { MemberIdentity } from '../workspace/MemberIdentity';
import { roleLabels, RoleBadge } from '../workspace/roles';
import { isCurrentCreator } from '../workspace/workspaceCreationController';
import { t, useTranslation, formatDate } from '../../i18n';
import { createIdempotencyKey } from '../../lib/idempotency';
import { queryKeys } from '../../lib/queryKeys';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { createInvitationMaterial } from './invitationMaterial';
import { fetchTeamView, teamQueryKey, prepareIssueInvitation, prepareMembershipUpdate, prepareRevokeInvitation } from './teamApi';
import { TeamCommandController } from './teamCommandController';

/** Mounted only for workspace owner/admin; the server enforces the same boundary. */
export function TeamAccessPanel({ actorId, workspace }: { actorId: string; workspace: WorkspaceDto }) {
  useTranslation();
  const me = useMe(), client = useQueryClient();
  const controller = useMemo(() => new TeamCommandController(client, actorId), [client, actorId]);
  const command = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const query = useQuery({ queryKey: teamQueryKey(actorId, workspace.id), queryFn: ({ signal }) => fetchTeamView(workspace.id, signal) });
  const [role, setRole] = useState<TeamInviteRole>('member');
  const [lifetime, setLifetime] = useState('604800');
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const link = useRef<{ invitationId: string; value: string } | null>(null);
  const [linkReady, setLinkReady] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [generationFailed, setGenerationFailed] = useState(false);
  const generationOwner = useRef(0);
  useEffect(() => {
    const owner = ++generationOwner.current;
    const detach = controller.attach((_result, sent) => {
      void client.invalidateQueries({ queryKey: teamQueryKey(actorId, workspace.id), exact: true });
      void client.invalidateQueries({ queryKey: queryKeys.memberships(actorId, workspace.id), exact: true });
      void client.invalidateQueries({ queryKey: queryKeys.workspace(actorId, workspace.id), exact: true });
      const input = sent.request.body as { id?: string };
      if (input.id && link.current?.invitationId === input.id) setLinkReady(true);
    });
    return () => { detach(); generationOwner.current = owner + 1; link.current = null; };
  }, [actorId, client, controller, workspace.id]);
  const shared = me.authMode === 'shared' && me.actor.kind === 'real';
  const busy = generating || command.phase !== 'idle';
  const writable = shared && query.isSuccess && !query.isFetching && isCurrentCreator(client, actorId);
  const createLink = async () => {
    if (!writable || busy || generatingRef.current || !query.data?.allowedInviteRoles.includes(role)) return;
    generatingRef.current = true; setGenerating(true); setGenerationFailed(false); setLinkReady(false); setCopyState('idle'); link.current = null;
    const owner = generationOwner.current;
    try {
      const material = await createInvitationMaterial(role, Number(lifetime));
      if (generationOwner.current !== owner || !isCurrentCreator(client, actorId)) return;
      link.current = { invitationId: material.input.id, value: material.link };
      controller.execute(prepareIssueInvitation(workspace.id, material.input, actorId, createIdempotencyKey()));
    } catch { if (generationOwner.current === owner) setGenerationFailed(true); }
    finally { if (generationOwner.current === owner) { generatingRef.current = false; setGenerating(false); } }
  };
  const copyLink = async () => {
    const value = link.current?.value;
    if (!value || !linkReady || !isCurrentCreator(client, actorId)) return;
    try { await navigator.clipboard.writeText(value); setCopyState('copied'); } catch { setCopyState('failed'); }
  };
  if (query.isPending) return <p role="status">{t('team.loading')}</p>;
  if (query.isError) return <QueryErrorState error={query.error} subject="members" retrying={query.isFetching} onRetry={() => void query.refetch()} />;
  const updateMember = (member: TeamMembershipDto, nextRole: TeamInviteRole, state: 'active' | 'revoked') => {
    if (!writable || busy) return;
    controller.execute(prepareMembershipUpdate(workspace.id, member.id, { role: nextRole, state, expectedRevision: member.revision }, actorId, createIdempotencyKey()));
  };
  return <section aria-label={t('team.title')} className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('team.title')}</h2><p className="mt-1 text-sm text-muted">{t('team.description')}</p></div><Button disabled={busy || query.isFetching} onClick={() => void query.refetch()}>{t('team.refresh')}</Button></div>
    {!shared ? <p className="text-sm text-muted">{t('team.join.signInFirst')}</p> : null}
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4">
      <label className="w-40 space-y-1 text-xs text-muted"><span>{t('team.role')}</span><ChoicePicker label={t('team.role')} value={role} disabled={busy || !writable} options={query.data.allowedInviteRoles.map(value => ({ value, label: roleLabels[value] }))} onValueChange={value => setRole(value as TeamInviteRole)} /></label>
      <label className="w-40 space-y-1 text-xs text-muted"><span>{t('team.expires')}</span><ChoicePicker label={t('team.expires')} value={lifetime} disabled={busy || !writable} options={[{ value: '604800', label: t('team.sevenDays') }, { value: '86400', label: t('team.oneDay') }]} onValueChange={setLifetime} /></label>
      <Button variant="primary" disabled={busy || !writable} onClick={() => void createLink()}>{t('team.invite')}</Button>
      {linkReady ? <Button onClick={() => void copyLink()}>{t(copyState === 'copied' ? 'team.copied' : 'team.copy')}</Button> : null}
      {linkReady ? <p className="w-full text-xs text-muted">{t('team.linkReady')}</p> : null}
      {copyState === 'failed' ? <p role="alert" className="w-full text-sm text-danger">{t('team.copyFailed')}</p> : null}
    </div>
    {command.error || generationFailed ? <p role="alert" className="text-sm text-danger">{t(command.phase === 'uncertain' ? 'team.command.uncertain' : 'team.command.failed')}</p> : null}
    {command.phase === 'uncertain' ? <Button disabled={!writable} onClick={() => controller.retry()}>{t('team.command.retry')}</Button> : null}
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{query.data.members.map(member => {
      const editable = member.state === 'active' && member.role !== 'owner' && (workspace.role === 'owner' || member.role !== 'admin');
      return <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><MemberIdentity member={member} isCurrent={member.userId === actorId} /><div className="flex items-center gap-2">{editable ? <><ChoicePicker compact label={t('team.memberRole', { name: member.displayName })} value={member.role} disabled={busy || !writable} className="w-32" options={query.data.allowedInviteRoles.map(value => ({ value, label: roleLabels[value] }))} onValueChange={value => updateMember(member, value as TeamInviteRole, 'active')} /><Button disabled={busy || !writable} onClick={() => updateMember(member, member.role as TeamInviteRole, 'revoked')}>{t('team.remove')}</Button></> : <RoleBadge role={member.role} />}{member.state === 'revoked' ? <span className="text-xs text-muted">{t('team.revoked')}</span> : null}</div></div>;
    })}</div>
    <section className="space-y-3"><h2 className="font-semibold">{t('team.invitations')}</h2>{query.data.invitations.length === 0 ? <p className="text-sm text-muted">{t('team.noInvitations')}</p> : <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{query.data.invitations.map(invite => {
      const state = invite.revokedAt ? 'revoked' : invite.acceptedAt ? 'accepted' : Date.parse(invite.expiresAt) <= Date.now() ? 'expired' : 'active';
      return <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="flex flex-wrap items-center gap-3 text-sm"><RoleBadge role={invite.role} /><span>{formatDate(invite.expiresAt, { dateStyle: 'medium' })}</span><span className="text-muted">{t(state === 'revoked' ? 'team.revoked' : state === 'accepted' ? 'team.accepted' : state === 'expired' ? 'team.expired' : 'team.active')}</span></div>{state === 'active' && query.data.allowedInviteRoles.includes(invite.role) ? <Button disabled={busy || !writable} onClick={() => controller.execute(prepareRevokeInvitation(workspace.id, invite.id, { expectedRevision: invite.revision }, actorId, createIdempotencyKey()))}>{t('team.revoke')}</Button> : null}</li>;
    })}</ul>}<p className="text-xs text-muted">{t('team.removedHelp')}</p></section>
  </section>;
}
