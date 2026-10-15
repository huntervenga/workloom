import type { MembershipDto } from '@workloom/contracts';
import { Avatar, Badge } from '@workloom/ui';

export function MemberIdentity({ member, isCurrent }: { member: MembershipDto; isCurrent: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={member.displayName} seed={member.userId} />
      <span className="min-w-0 font-medium [overflow-wrap:anywhere] text-ink">{member.displayName}</span>
      {isCurrent ? (
        <Badge tone="accent" title="Текущий пользователь">
          Вы
        </Badge>
      ) : null}
    </div>
  );
}
