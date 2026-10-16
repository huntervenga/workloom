import { Button } from '@workloom/ui';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { DependencyWorkspace } from './useDependencyWorkspace';
export function DependencyNotices({ controller: c }: { controller: DependencyWorkspace }) {
  return <>{(['create', 'update', 'policy', 'layout'] as const).map(kind => {
    const command = c.commands[kind];
    const held = command.pendingCommand?.variables ?? command.uncertain?.variables;
    if (!held) return null;
    const label = kind === 'create' ? 'Добавление связи' : kind === 'update' ? 'Изменение связи' : kind === 'policy' ? 'Правило блокировок' : 'Личная раскладка';
    return <div key={kind} role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{label}: {command.pendingCommand ? 'ждём ответа' : 'результат неизвестен'}. Исходная отправка сохранена.</p><div className="flex flex-wrap gap-2">{kind === 'create' && 'anchorTaskId' in held ? <Button size="sm" onClick={() => c.setActiveAnchor(held.anchorTaskId)}>Открыть исходную связь</Button> : null}{command.uncertain ? <Button size="sm" onClick={() => command.retryUncertain()}>Повторить исходную отправку</Button> : null}</div><SaveFeedback subject="taskSave" error={null} uncertainError={command.uncertain?.error ?? null} /></div>;
  })}</>;
}
