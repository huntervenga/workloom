import { t, useTranslation } from '../../i18n';
import type { MembershipDto } from '@workloom/contracts';
import { Badge } from '@workloom/ui';
import { UserAvatar } from '../../shared/UserAvatar';

export function MemberIdentity({ member, isCurrent }: { member: MembershipDto; isCurrent: boolean }) {
  useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <UserAvatar name={member.displayName} seed={member.userId} avatarUrl={member.avatarUrl} />
      <span className="min-w-0 font-medium [overflow-wrap:anywhere] text-ink">{member.displayName}</span>
      {member.pending ? <Badge tone="accent" title={t('team.personal.pendingHelp')}>{t('team.personal.pending')}</Badge> : null}
      {isCurrent ? (
        <Badge tone="accent" title={t('workspace.currentUser')}>

          {t('workspace.you')}
        </Badge>
      ) : null}
    </div>
  );
}
