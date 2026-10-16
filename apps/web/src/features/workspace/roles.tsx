import { t, useTranslation } from '../../i18n';
import type { WorkspaceDto } from '@workloom/contracts';
import { Badge, type BadgeTone } from '@workloom/ui';

export type WorkspaceRole = WorkspaceDto['role'];

export const roleLabels: Record<WorkspaceRole, string> = {
  get owner() { return t('workspace.owner'); },
  get admin() { return t('workspace.admin'); },
  get member() { return t('routes.member'); },
  get viewer() { return t('workspace.viewer'); },
};

const roleTones: Record<WorkspaceRole, BadgeTone> = {
  owner: 'accent',
  admin: 'accent',
  member: 'neutral',
  viewer: 'muted',
};

export function RoleBadge({ role }: { role: WorkspaceRole }) {
  useTranslation();
  return <Badge tone={roleTones[role]}>{roleLabels[role]}</Badge>;
}
