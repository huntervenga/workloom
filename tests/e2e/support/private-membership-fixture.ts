// PRIVATE TEST DATA ONLY. No Auth accounts/invites are created and no production command is bypassed.
// Root supplies the throwaway child URL explicitly and owns its lifecycle; this module starts nothing.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { idSchema } from '@workloom/contracts';

export interface PrivateSyntheticMember { id: string; userId: string; displayName: string; role: 'member' }
export function requirePrivateMembershipDatabase(): URL {
  const raw = process.env.WORKLOOM_QA_DATABASE_URL;
  if (!raw) throw new Error('Explicit WORKLOOM_QA_DATABASE_URL is required for private membership fixtures.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Private QA database URL is invalid.'); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '60651'
    || decodeURIComponent(url.username) !== 'workloom_qa' || !/^workloom_test_[a-z0-9_]+_test$/.test(database)
    || url.search !== '' || url.hash !== '') {
    throw new Error('Membership fixtures require the explicitly owned loopback60651 throwaway child; no fallback.');
  }
  return url;
}

/** Two non-login synthetic teammates, only in this test's fresh real owner's still-empty workspace. */
export async function addPrivateSyntheticMembers(workspaceId: string, realOwnerId: string): Promise<PrivateSyntheticMember[]> {
  const ws = idSchema.parse(workspaceId), owner = idSchema.parse(realOwnerId);
  const url = requirePrivateMembershipDatabase();
  const sql = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 3, onnotice: () => undefined });
  try {
    const result = await sql.begin(async tx => {
      const [connection] = await tx<{ database: string; username: string; host: string; port: number }[]>`
        select current_database() as database, current_user as username,
          host(inet_server_addr()) as host, inet_server_port()::int as port`;
      if (!connection || connection.database !== decodeURIComponent(url.pathname.slice(1)) || connection.username !== 'workloom_qa'
        || connection.host !== '127.0.0.1' || connection.port !== 60651) throw new Error('Private fixture connection identity mismatch.');
      const [workspace] = await tx<{ id: string; age: string }[]>`
        select w.id, extract(epoch from (now() - w.created_at))::text as age
        from workspaces w join memberships m on m.workspace_id = w.id join users u on u.id = m.user_id
        where w.id = ${ws} and m.user_id = ${owner} and m.role = 'owner' and m.state = 'active'
          and u.kind = 'real' for update of w`;
      if (!workspace || !Number.isFinite(Number(workspace.age)) || Number(workspace.age) < 0 || Number(workspace.age) > 300) throw new Error('Expected this test freshly authenticated real owner workspace.');
      const [scope] = await tx<{ memberships: number; projects: number }[]>`
        select (select count(*)::int from memberships where workspace_id = ${ws}) as memberships,
          (select count(*)::int from projects where workspace_id = ${ws}) as projects`;
      if (!scope || scope.memberships !== 1 || scope.projects !== 0) throw new Error('Membership fixture requires an untouched owned workspace.');
      const members: PrivateSyntheticMember[] = ['Native teammate A', 'Native teammate B'].map(displayName => ({
        id: randomUUID(), userId: randomUUID(), displayName, role: 'member',
      }));
      for (const member of members) {
        await tx`insert into users (id, display_name, kind) values (${member.userId}, ${member.displayName}, 'fixture')`;
        await tx`insert into memberships (id, workspace_id, user_id, role) values (${member.id}, ${ws}, ${member.userId}, 'member')`;
      }
      await tx`update workspaces set permission_epoch = permission_epoch + 1, updated_at = now() where id = ${ws}`;
      return { members };
    });
    return result.members;
  } finally { await sql.end({ timeout: 5 }); }
}
