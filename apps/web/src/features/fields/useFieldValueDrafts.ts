import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import type { SetFieldValueMutation } from './FieldValueForm';
import { ObservableFieldValueDraftStore } from './fieldValueDraftStore';

/** Page-owned lifetime covers closed drawers and isolates old actor/workspace/project callbacks. */
export function useFieldValueDrafts(actorId: string, workspaceId: string, projectId: string, mutation: SetFieldValueMutation) {
  const owner = useMemo(() => ({ actorId, workspaceId, projectId, current: new ObservableFieldValueDraftStore() }), [actorId, workspaceId, projectId]);
  const registry = protectedDraftsFor(useQueryClient());
  useEffect(() => {
    const entry = registry.register();
    const sync = () => entry.set(owner.current.getSnapshot());
    const unsubscribe = owner.current.subscribe(sync);
    sync();
    const warn = (event: BeforeUnloadEvent) => {
      if (!owner.current.getSnapshot()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { unsubscribe(); entry.dispose(); window.removeEventListener('beforeunload', warn); };
  }, [owner, registry]);
  useEffect(() => { if (mutation.data) owner.current.confirm(mutation.data); }, [owner, mutation.data]);
  return owner;
}
