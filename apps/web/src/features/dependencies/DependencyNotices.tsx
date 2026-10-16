import { useTranslation } from '../../i18n';
import { Button } from '@workloom/ui';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { DependencyWorkspace } from './useDependencyWorkspace';
export function DependencyNotices({ controller: c }: { controller: DependencyWorkspace }) {
  const { t } = useTranslation();
  return <>{(['create', 'update', 'policy', 'layout'] as const).map(kind => {
    const command = c.commands[kind];
    const held = command.pendingCommand?.variables ?? command.uncertain?.variables;
    if (!held) return null;
    const message = kind === 'create'
      ? command.pendingCommand ? 'dependencies.dependencyNotices.createPending' : 'dependencies.dependencyNotices.createUnconfirmed'
      : kind === 'update'
        ? command.pendingCommand ? 'dependencies.dependencyNotices.updatePending' : 'dependencies.dependencyNotices.updateUnconfirmed'
        : kind === 'policy'
          ? command.pendingCommand ? 'dependencies.dependencyNotices.policyPending' : 'dependencies.dependencyNotices.policyUnconfirmed'
          : command.pendingCommand ? 'dependencies.dependencyNotices.layoutPending' : 'dependencies.dependencyNotices.layoutUnconfirmed';
    return <div key={kind} role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{t(message)}</p><div className="flex flex-wrap gap-2">{kind === 'create' && 'anchorTaskId' in held ? <Button size="sm" onClick={() => c.setActiveAnchor(held.anchorTaskId)}>{t('dependencies.dependencyNotices.openOriginalDependency')}</Button> : null}{command.uncertain ? <Button size="sm" onClick={() => command.retryUncertain()}>{t('dependencies.dependencyNotices.retryOriginalSubmission')}</Button> : null}</div><SaveFeedback subject="taskSave" error={null} uncertainError={command.uncertain?.error ?? null} /></div>;
  })}</>;
}
