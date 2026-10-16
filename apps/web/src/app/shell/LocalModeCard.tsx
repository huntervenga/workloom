import type { MeDto } from '@workloom/contracts';
import { Avatar } from '@workloom/ui';
import { FlaskConical } from 'lucide-react';
import { lazy, Suspense, useId } from 'react';
import { roleLabels, type WorkspaceRole } from '../../features/workspace/roles';
import { useTranslation } from '../../i18n';

// Compiled out of production builds: import.meta.env.DEV is statically false there.
const DevActorSwitcher = import.meta.env.DEV ? lazy(() => import('../../dev/DevActorSwitcher')) : null;

export function LocalModeCard({ me, role }: { me: MeDto; role: WorkspaceRole | null }) {
  const { t } = useTranslation();
  const titleId = useId();
  if (me.authMode !== 'dev') return null;

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-line bg-canvas/70 p-2.5">
      <div className="flex items-center gap-2.5">
        <Avatar name={me.actor.displayName} seed={me.actor.id} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink" title={me.actor.displayName}>{me.actor.displayName}</p>
          <p className="truncate text-xs text-muted">{role ? roleLabels[role] : t('shell.testUser')}</p>
        </div>
      </div>
      {DevActorSwitcher ? (
        <Suspense fallback={null}><DevActorSwitcher currentActorId={me.actor.id} /></Suspense>
      ) : null}
      <details className="mt-1 text-[11px] leading-relaxed text-muted">
        <summary id={titleId} className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 font-medium text-muted hover:text-ink">
          <FlaskConical size={12} aria-hidden="true" />{t('shell.localDemo')}
        </summary>
        <p className="px-1 pt-1 pb-0.5">{t('shell.syntheticData')}</p>
      </details>
    </section>
  );
}
