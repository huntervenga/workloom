import type { ColumnChoice, UpdatePersonalTablePreferenceInput } from '@workloom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { fetchPersonalColumns, preferenceKey, setPersonalColumnsRequest } from './personalColumnsApi';

export interface PersonalColumnsDraft { expectedRevision: number; columns: ColumnChoice[] | null }
interface Variables extends IdempotentVariables { input: UpdatePersonalTablePreferenceInput; session: PersonalColumnsDraft }
const unavailable = (error: unknown) => isAccessDenied(error) || error instanceof ApiError && error.kind === 'unauthenticated';
/** Owns draft/command above the dialog lifetime. Receipts never replace the authoritative head. */
export function usePersonalTablePreference(actorId: string, workspaceId: string, projectId: string, membershipId: string) {
  const client = useQueryClient();
  const key = preferenceKey(actorId, workspaceId, projectId);
  const queryFn = ({ signal }: { signal?: AbortSignal } = {}) => fetchPersonalColumns(workspaceId, projectId, membershipId, signal);
  const query = useQuery({ queryKey: key, queryFn, enabled: isUuid(membershipId) });
  const [draft, setDraftState] = useState<PersonalColumnsDraft | null>(null);
  const draftRef = useRef(draft);
  const [open, setOpen] = useState(false);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [head, setHead] = useState<'idle' | 'loading' | 'failed'>('idle');
  const refreshHead = async () => {
    setHead('loading');
    try { await client.cancelQueries({ queryKey: key, exact: true }); await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 }); setHead('idle'); return true; }
    catch { setHead('failed'); return false; }
  };
  const command = useIdempotentMutation({
    prepare: ({ input }: Variables) => setPersonalColumnsRequest(workspaceId, projectId, membershipId, input),
    onSuccess: (_receipt, variables) => {
      setSaveConfirmed(true);
      if (draftRef.current === variables.session) { draftRef.current = null; setDraftState(null); }
      // An exact replay can return an old receipt; always fetch the current persisted row.
      void refreshHead();
    },
  });
  const held = command.pendingCommand ?? command.uncertain;
  // Read after an awaited head fetch, so a command that started or settled meanwhile is never reset or rebased.
  const live = useRef({ held, error: command.error });
  useLayoutEffect(() => { live.current = { held, error: command.error }; });
  const denied = unavailable(query.error) || unavailable(command.error);
  const frozen = held !== null || head !== 'idle' || denied;
  const setDraft = (columns: ColumnChoice[] | null) => {
    if (frozen || !query.data) return;
    const next = { expectedRevision: draftRef.current?.expectedRevision ?? query.data.revision, columns };
    draftRef.current = next; setDraftState(next); setSaveConfirmed(false);
  };
  const discard = () => {
    if (held) return;
    const conflicted = command.error instanceof ApiError && command.error.kind === 'conflict';
    setSaveConfirmed(false); draftRef.current = null; setDraftState(null); if (!unavailable(command.error)) command.reset();
    // A confirmed conflict proves the cached head is stale; stay frozen until the current row arrives.
    if (conflicted) void refreshHead();
  };
  const reload = async () => {
    // Only a confirmed conflict, captured before the read, proves the retained draft's base is stale.
    const before = command.error;
    const conflicted = before instanceof ApiError && before.kind === 'conflict';
    const result = await query.refetch();
    if (!result.isSuccess) return;
    setHead('idle');
    // The read is always allowed; a pending or unconfirmed command keeps its draft, body and key.
    if (live.current.held || live.current.error !== before) return;
    const current = draftRef.current;
    if (conflicted && current) { const next = { ...current, expectedRevision: result.data.revision }; draftRef.current = next; setDraftState(next); }
    command.reset();
  };
  const save = (columns: ColumnChoice[] | null) => {
    if (held || head !== 'idle' || denied || !query.data || command.error instanceof ApiError && command.error.kind === 'conflict') return;
    const current = draftRef.current;
    if (!current) return;
    const session = { ...current, columns };
    draftRef.current = session; setDraftState(session);
    command.mutate({ input: { expectedRevision: session.expectedRevision, columns }, session });
  };
  useUnsavedChangesWarning(draft !== null || held !== null);
  return { query, draft, setDraft, discard, reload, save, command, held, denied, frozen, open, setOpen, head, refreshHead, saveConfirmed };
}
export type PersonalTablePreferenceController = ReturnType<typeof usePersonalTablePreference>;
