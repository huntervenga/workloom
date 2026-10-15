import type { WorkspaceDto } from '@workloom/contracts';
import { Badge, type BadgeTone } from '@workloom/ui';

export type WorkspaceRole = WorkspaceDto['role'];

export const roleLabels: Record<WorkspaceRole, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  member: 'Участник',
  viewer: 'Наблюдатель',
};

const roleTones: Record<WorkspaceRole, BadgeTone> = {
  owner: 'accent',
  admin: 'accent',
  member: 'neutral',
  viewer: 'muted',
};

export function RoleBadge({ role }: { role: WorkspaceRole }) {
  return <Badge tone={roleTones[role]}>{roleLabels[role]}</Badge>;
}
