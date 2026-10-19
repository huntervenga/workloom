import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { isNativeUndoTarget } from './UndoStore';
import { projectUndoFor, undoScope } from './projectUndo';
export interface ProjectUndoSurfaceProps { actorId: string; workspaceId: string; projectId: string; writable: boolean }
export function ProjectUndoSurface({ actorId, workspaceId, projectId, writable }: ProjectUndoSurfaceProps) {
  const { t } = useTranslation();
  const store = projectUndoFor(useQueryClient());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const scope = undoScope(actorId, workspaceId, projectId);
  useEffect(() => { store.activate(scope, false); return () => store.activate(null, false); }, [store, scope]);
  useEffect(() => { store.setWritable(writable); }, [store, scope, writable]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!writable || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || isNativeUndoTarget(event.target) || store.getSnapshot().count === 0) return;
      event.preventDefault(); void store.undo();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [store, writable]);
  useEffect(() => {
    if (state.notice !== 'available' && state.notice !== 'done' && state.notice !== 'cleared') return;
    const timer = window.setTimeout(store.dismiss, 5000); return () => window.clearTimeout(timer);
  }, [store, state.notice, state.version]);
  if (!state.notice) return null;
  const text = state.notice === 'available' ? state.critical ? t('undo.archived') : t('undo.saved') : state.notice === 'pending' ? t('undo.pending') : state.notice === 'unknown' ? t('undo.unknown') : state.notice === 'unsupported' ? t('undo.unsupported') : state.notice === 'blocked' ? t('undo.blocked') : state.notice === 'cleared' ? t('undo.cleared') : t('undo.done');
  const actionable = state.count > 0 && state.notice !== 'pending' && state.notice !== 'unsupported' && state.notice !== 'done' && state.notice !== 'cleared';
  return <div role="status" aria-live="polite" className="fixed bottom-5 left-5 z-[90] flex max-w-md items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink shadow-lg">
    <span>{text}</span>
    {actionable && <button type="button" className="shrink-0 font-medium text-accent underline" onClick={() => void store.undo()}>{state.notice === 'unknown' ? t('undo.retry') : t('undo.action')}</button>}
    {state.notice !== 'pending' && state.notice !== 'unknown' && <button type="button" className="shrink-0 text-muted" aria-label={t('undo.dismiss')} onClick={store.dismiss}>×</button>}
  </div>;
}
