import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type TeamInvitationDto, type TeamInvitationRecipient, type TeamInviteRole, type TeamMembershipDto, type WorkspaceDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useMe } from '../identity/identity';
import { MemberIdentity } from '../workspace/MemberIdentity';
import { roleLabels, RoleBadge } from '../workspace/roles';
import { isCurrentCreator } from '../workspace/workspaceCreationController';
import { t, useTranslation, formatDate } from '../../i18n';
import { createIdempotencyKey } from '../../lib/idempotency';
import { queryKeys } from '../../lib/queryKeys';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { createInvitationMaterial } from './invitationMaterial';
import { fetchTeamView, teamQueryKey, prepareIssueInvitation, prepareMembershipUpdate, prepareRevokeInvitation } from './teamApi';
import { TeamCommandController } from './teamCommandController';

/** Pending people are assignable, but have no account access until they claim their own link. */
export function TeamAccessPanel({ actorId, workspace }: { actorId: string; workspace: WorkspaceDto }) {
  useTranslation();
  const me = useMe(), client = useQueryClient();
  const controller = useMemo(() => new TeamCommandController(client, actorId), [client, actorId]);
  const command = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const query = useQuery({ queryKey: teamQueryKey(actorId, workspace.id), queryFn: ({ signal }) => fetchTeamView(workspace.id, signal) });
  const [role, setRole] = useState<TeamInviteRole>('member');
  const [lifetime, setLifetime] = useState('604800');
  const [general, setGeneral] = useState(false);
  const [firstName, setFirstName] = useState(''), [lastName, setLastName] = useState(''), [email, setEmail] = useState('');
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const link = useRef<{ invitationId: string; value: string } | null>(null);
  const [linkReady, setLinkReady] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [generationFailed, setGenerationFailed] = useState(false);
  const generationOwner = useRef(0);
  const readyBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (linkReady) readyBox.current?.scrollIntoView?.({ block: 'center' }); }, [linkReady]);
  useProtectedDraft(command.phase === 'idle' && Boolean(firstName || lastName || email));
  useEffect(() => {
    const owner = ++generationOwner.current;
    const detach = controller.attach((_result, sent) => {
      void client.invalidateQueries({ queryKey: teamQueryKey(actorId, workspace.id), exact: true });
      void client.invalidateQueries({ queryKey: queryKeys.memberships(actorId, workspace.id), exact: true });
      void client.invalidateQueries({ queryKey: queryKeys.workspace(actorId, workspace.id), exact: true });
      const input = sent.request.body as { id?: string };
      if (input.id && link.current?.invitationId === input.id) {
        setLinkReady(true); setFirstName(''); setLastName(''); setEmail('');
      }
    });
    return () => { detach(); generationOwner.current = owner + 1; link.current = null; };
  }, [actorId, client, controller, workspace.id]);
  const shared = me.authMode === 'shared' && me.actor.kind === 'real';
  const busy = generating || command.phase !== 'idle';
  const writable = shared && query.isSuccess && !query.isFetching && isCurrentCreator(client, actorId);
  const createLink = async (recipient?: TeamInvitationRecipient, inviteRole = role) => {
    if (!writable || busy || generatingRef.current || !query.data?.allowedInviteRoles.includes(inviteRole)) return;
    generatingRef.current = true; setGenerating(true); setGenerationFailed(false); setLinkReady(false); setCopyState('idle'); link.current = null;
    const owner = generationOwner.current;
    try {
      const material = await createInvitationMaterial(inviteRole, Number(lifetime), recipient);
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
  const reissue = (invite: TeamInvitationDto) => {
    if (!invite.recipient || !invite.pendingMembershipId) return;
    void createLink(invite.recipient, invite.role);
  };
  return <section aria-label={t('team.title')} className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('team.title')}</h2><p className="mt-1 text-sm text-muted">{t('team.description')}</p></div><Button disabled={busy || query.isFetching} onClick={() => void query.refetch()}>{t('team.refresh')}</Button></div>
    {!shared ? <p className="text-sm text-muted">{t('team.join.signInFirst')}</p> : null}
    <form aria-label={t('team.personal.form')} onSubmit={event => {
      event.preventDefault();
      void createLink(general ? undefined : { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim().toLowerCase() });
    }} className="space-y-4 rounded-xl border border-line bg-surface p-4">
      <div><h3 className="font-medium text-ink">{t('team.personal.title')}</h3><p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{t('team.personal.description')}</p></div>
      {!general ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1 text-xs text-muted"><span>{t('team.personal.firstName')}</span><input autoComplete="given-name" maxLength={100} required value={firstName} disabled={busy || !writable} onChange={event => setFirstName(event.target.value)} className="min-h-10 w-full rounded-lg border border-line bg-canvas px-3 text-sm text-ink" /></label>
        <label className="space-y-1 text-xs text-muted"><span>{t('team.personal.lastName')}</span><input autoComplete="family-name" maxLength={100} value={lastName} disabled={busy || !writable} onChange={event => setLastName(event.target.value)} className="min-h-10 w-full rounded-lg border border-line bg-canvas px-3 text-sm text-ink" /></label>
        <label className="space-y-1 text-xs text-muted"><span>{t('team.personal.email')}</span><input type="email" autoComplete="email" maxLength={254} required value={email} disabled={busy || !writable} onChange={event => setEmail(event.target.value)} className="min-h-10 w-full rounded-lg border border-line bg-canvas px-3 text-sm text-ink" /></label>
      </div> : <p className="text-sm text-muted">{t('team.personal.generalHelp')}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-40 space-y-1 text-xs text-muted"><span>{t('team.role')}</span><ChoicePicker label={t('team.role')} value={role} disabled={busy || !writable} options={query.data.allowedInviteRoles.map(value => ({ value, label: roleLabels[value] }))} onValueChange={value => setRole(value as TeamInviteRole)} /></label>
        <label className="w-40 space-y-1 text-xs text-muted"><span>{t('team.expires')}</span><ChoicePicker label={t('team.expires')} value={lifetime} disabled={busy || !writable} options={[{ value: '604800', label: t('team.sevenDays') }, { value: '86400', label: t('team.oneDay') }]} onValueChange={setLifetime} /></label>
        <Button type="submit" variant="primary" disabled={busy || !writable}>{t('team.invite')}</Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={general} disabled={busy || !writable} onChange={event => setGeneral(event.target.checked)} />{t('team.personal.general')}</label>
      {linkReady ? <div ref={readyBox} role="status" className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3"><div className="flex flex-wrap items-center gap-3"><Button onClick={() => void copyLink()}>{t(copyState === 'copied' ? 'team.copied' : 'team.copy')}</Button><p className="max-w-xl text-xs text-muted">{t('team.linkReady')}</p></div><input readOnly aria-label={t('team.linkField')} value={link.current?.value ?? ''} onFocus={event => event.currentTarget.select()} className="min-h-10 w-full rounded-lg border border-line bg-canvas px-3 text-xs text-ink" /></div> : null}
      {copyState === 'failed' ? <p role="alert" className="text-sm text-danger">{t('team.copyFailed')}</p> : null}
    </form>
    {command.error || generationFailed ? <p role="alert" className="text-sm text-danger">{t(command.phase === 'uncertain' ? 'team.command.uncertain' : 'team.command.failed')}</p> : null}
    {command.phase === 'uncertain' ? <Button disabled={!writable} onClick={() => controller.retry()}>{t('team.command.retry')}</Button> : null}
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{query.data.members.map(member => {
      const editable = member.state === 'active' && member.role !== 'owner' && (workspace.role === 'owner' || member.role !== 'admin');
      return <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><MemberIdentity member={member} isCurrent={member.userId === actorId} />{member.email ? <p className="mt-1 pl-11 text-xs text-muted [overflow-wrap:anywhere]">{member.email}</p> : null}</div><div className="flex items-center gap-2">{editable ? <>{member.pending ? <RoleBadge role={member.role} /> : <ChoicePicker compact label={t('team.memberRole', { name: member.displayName })} value={member.role} disabled={busy || !writable} className="w-32" options={query.data.allowedInviteRoles.map(value => ({ value, label: roleLabels[value] }))} onValueChange={value => updateMember(member, value as TeamInviteRole, 'active')} />}<Button disabled={busy || !writable} onClick={() => updateMember(member, member.role as TeamInviteRole, 'revoked')}>{t('team.remove')}</Button></> : <RoleBadge role={member.role} />}{member.state === 'revoked' ? <span className="text-xs text-muted">{t('team.revoked')}</span> : null}</div></div>;
    })}</div>
    <section className="space-y-3"><h2 className="font-semibold">{t('team.invitations')}</h2>{query.data.invitations.length === 0 ? <p className="text-sm text-muted">{t('team.noInvitations')}</p> : <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{query.data.invitations.map((invite, index) => {
      const state = invite.revokedAt ? 'revoked' : invite.acceptedAt ? 'accepted' : Date.parse(invite.expiresAt) <= Date.now() ? 'expired' : 'active';
      const pending = invite.pendingMembershipId && query.data.members.some(member => member.id === invite.pendingMembershipId && member.pending);
      const latest = !query.data.invitations.some((other, otherIndex) => other.pendingMembershipId === invite.pendingMembershipId && (other.createdAt > invite.createdAt || (other.createdAt === invite.createdAt && otherIndex > index)));
      return <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="min-w-0 space-y-1">{invite.recipient ? <div><p className="font-medium text-ink">{invite.recipient.firstName} {invite.recipient.lastName}</p><p className="text-xs text-muted [overflow-wrap:anywhere]">{invite.recipient.email}</p></div> : <p className="text-sm text-ink">{t('team.personal.generalTitle')}</p>}<div className="flex flex-wrap items-center gap-3 text-xs"><RoleBadge role={invite.role} /><span>{t('team.personal.expiresOn', { date: formatDate(invite.expiresAt, { dateStyle: 'medium' }) })}</span><span className="text-muted">{t(state === 'revoked' ? 'team.revoked' : state === 'accepted' ? 'team.accepted' : state === 'expired' ? 'team.expired' : 'team.active')}</span></div></div><div className="flex flex-wrap gap-2">{pending && latest && query.data.allowedInviteRoles.includes(invite.role) ? <Button disabled={busy || !writable} onClick={() => reissue(invite)}>{t('team.personal.newLink')}</Button> : null}{state === 'active' && query.data.allowedInviteRoles.includes(invite.role) ? <Button disabled={busy || !writable} onClick={() => controller.execute(prepareRevokeInvitation(workspace.id, invite.id, { expectedRevision: invite.revision }, actorId, createIdempotencyKey()))}>{t('team.revoke')}</Button> : null}</div></li>;
    })}</ul>}<p className="text-xs text-muted">{t('team.personal.reissueHelp')}</p><p className="text-xs text-muted">{t('team.removedHelp')}</p></section>
  </section>;
}
