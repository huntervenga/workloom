import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApplyProjectImportInput, ProjectImportAppliedDto, ProjectImportDto, StageCsvImportInput } from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { applyImportRequest, fetchImportReconciliation, fetchProjectImport, stageImportRequest } from './api';
export const importKeys = {
  root: (a: string, w: string, p: string) => [...queryKeys.workspace(a, w), 'imports', p] as const,
  artifact: (a: string, w: string, p: string, id: string) => [...importKeys.root(a, w, p), id] as const,
  reconciliation: (a: string, w: string, p: string, id: string) => [...importKeys.artifact(a, w, p, id), 'reconciliation'] as const,
};
export function useProjectImport(a: string, w: string, p: string, id: string, enabled: boolean) {
  const client = useQueryClient();
  const key = importKeys.artifact(a, w, p, id);
  return useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const incoming = await fetchProjectImport(w, p, id, signal);
    const cached = client.getQueryData<ProjectImportDto>(key);
    return cached && cached.revision > incoming.revision ? cached : incoming;
  }, enabled: enabled && isUuid(id), retry: false });
}
export const useImportReconciliation = (a: string, w: string, p: string, id: string, enabled: boolean) => useQuery({ queryKey: importKeys.reconciliation(a, w, p, id), queryFn: ({ signal }) => fetchImportReconciliation(w, p, id, signal), enabled: enabled && isUuid(id), retry: false });
export interface StageImportVariables extends IdempotentVariables { draftId: string; input: StageCsvImportInput }
export interface ApplyImportVariables extends IdempotentVariables { draftId: string; importId: string; input: ApplyProjectImportInput }
export function useImportCommands(a: string, w: string, p: string, onStage: (data: ProjectImportDto, variables: StageImportVariables) => void, onApply: (data: ProjectImportAppliedDto, variables: ApplyImportVariables) => void) {
  const client = useQueryClient();
  const stage = useIdempotentMutation({ prepare: (v: StageImportVariables) => stageImportRequest(w, p, v.input), onSuccess: (data, variables) => {
    const key = importKeys.artifact(a, w, p, data.id), cached = client.getQueryData<ProjectImportDto>(key);
    if (!cached || cached.revision <= data.revision) client.setQueryData(key, data);
    void client.invalidateQueries({ queryKey: key }); onStage(data, variables);
  } });
  const apply = useIdempotentMutation({ prepare: (v: ApplyImportVariables) => applyImportRequest(w, p, v.importId, v.input), onSuccess: (data, variables) => {
    // Stored receipts may predate independently edited tasks. Refetch current state, never merge them.
    void client.invalidateQueries({ queryKey: importKeys.artifact(a, w, p, variables.importId) });
    void client.invalidateQueries({ queryKey: queryKeys.tasks(a, w) });
    void client.invalidateQueries({ queryKey: queryKeys.fields(a, w) });
    for (const prefix of ['schedule', 'planning', 'dependencies']) void client.invalidateQueries({ queryKey: [...queryKeys.workspace(a, w), prefix] });
    onApply(data, variables);
  } });
  return { stage, apply };
}
