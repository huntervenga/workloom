import { Skeleton, StateCard } from '@workloom/ui';
import { Users } from 'lucide-react';
import { MemberIdentity } from '../features/workspace/MemberIdentity';
import { useMembershipsQuery } from '../features/workspace/queries';
import { RoleBadge } from '../features/workspace/roles';
import { formatMemberCount } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function MembersPage() {
  const { actorId, workspace } = useWorkspaceContext();
  const members = useMembershipsQuery(actorId, workspace.id);
  useDocumentTitle(`Участники · ${workspace.name}`);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">Участники</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
          {members.isSuccess
            ? `${formatMemberCount(members.data.length)} в пространстве «${workspace.name}».`
            : 'Состав пространства и роли участников.'}{' '}
          Приглашения и управление ролями появятся вместе со входом.
        </p>
      </header>

      {members.isPending ? (
        <div role="status" className="space-y-px overflow-hidden rounded-2xl border border-line bg-surface">
          <span className="sr-only">Загрузка участников</span>
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 w-40" />
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ) : members.isError ? (
        <QueryErrorState
          error={members.error}
          subject="members"
          retrying={members.isFetching}
          onRetry={() => void members.refetch()}
        />
      ) : members.data.length === 0 ? (
        <StateCard
          icon={<Users size={18} aria-hidden="true" />}
          title="Участников пока нет"
          description="В этом пространстве ещё никого нет."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Участники пространства «{workspace.name}»</caption>
            <thead className="border-b border-line bg-canvas/70 text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium sm:px-5">
                  Участник
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium sm:px-5">
                  Роль
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {members.data.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3 sm:px-5">
                    <MemberIdentity member={member} isCurrent={member.userId === actorId} />
                  </td>
                  <td className="px-4 py-3 text-right sm:px-5">
                    <RoleBadge role={member.role} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
