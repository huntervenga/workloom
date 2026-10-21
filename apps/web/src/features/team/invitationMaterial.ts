import { teamInvitationSecretPreimage, type IssueTeamInvitationInput, type TeamInviteRole, type TeamInvitationRecipient } from '@workloom/contracts';
/** Strong per-link entropy. No storage or network; the URL is handed only to the clipboard. */
export async function createInvitationMaterial(role: TeamInviteRole, expiresInSeconds: number, recipient?: TeamInvitationRecipient): Promise<{ input: IssueTeamInvitationInput; link: string }> {
  const id = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(teamInvitationSecretPreimage(id, bytes)));
  const secretHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  return { input: { id, hashVersion: 1, secretHash, role, expiresInSeconds, ...(recipient ? { recipient: { ...recipient } } : {}) }, link: `${window.location.origin}/app/join#${id}.${secret}` };
}
