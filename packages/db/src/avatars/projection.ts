import { sql } from 'drizzle-orm';
import { users } from '../schema.js';

/** Stable authenticated URL; neither expiring signatures nor storage keys enter user DTOs. */
export function userAvatarSql(alias?: 'au' | 'cu') {
  const id = alias ? sql`${sql.identifier(alias)}.id` : sql`${users.id}`;
  const avatarId = alias ? sql`${sql.identifier(alias)}.avatar_id` : sql`${users.avatarId}`;
  const provider = alias ? sql`${sql.identifier(alias)}.avatar_url` : sql`${users.avatarUrl}`;
  return sql<string | null>`case when ${avatarId} is not null then '/api/v1/users/' || ${id}::text || '/avatars/' || ${avatarId}::text else ${provider} end`;
}
