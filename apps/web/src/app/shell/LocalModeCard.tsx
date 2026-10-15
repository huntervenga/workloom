import type { MeDto } from '@workloom/contracts';
import { Avatar } from '@workloom/ui';
import { FlaskConical } from 'lucide-react';
import { lazy, Suspense, useId } from 'react';
import { roleLabels, type WorkspaceRole } from '../../features/workspace/roles';

// Compiled out of production builds: import.meta.env.DEV is statically false there.
const DevActorSwitcher = import.meta.env.DEV ? lazy(() => import('../../dev/DevActorSwitcher')) : null;

export function LocalModeCard({ me, role }: { me: MeDto; role: WorkspaceRole | null }) {
  const titleId = useId();
  if (me.authMode !== 'dev') return null;

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-amber-200/80 bg-amber-50/60 p-3">
      <h2 id={titleId} className="flex items-start gap-2 text-xs leading-snug font-semibold text-amber-900">
        <FlaskConical size={16} aria-hidden="true" className="shrink-0" />
        Локальный режим — тестовый пользователь
      </h2>
      <p className="mt-1 pl-6 text-[11px] leading-relaxed text-amber-800/90">Синтетические данные, вход не нужен.</p>
      <div className="mt-3 flex items-center gap-2.5 rounded-lg bg-surface/90 p-2 ring-1 ring-amber-200/60">
        <Avatar name={me.actor.displayName} seed={me.actor.id} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" title={me.actor.displayName}>
            {me.actor.displayName}
          </p>
          <p className="truncate text-xs text-muted">{role ? roleLabels[role] : 'Тестовый пользователь'}</p>
        </div>
      </div>
      {DevActorSwitcher ? (
        <Suspense fallback={null}>
          <DevActorSwitcher currentActorId={me.actor.id} />
        </Suspense>
      ) : null}
    </section>
  );
}
