import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeaveProfileDto, LeaveRequestDto, LeaveSettingsDto, PreviewLeaveRequestInput, ApplyLeaveTemplateInput, BulkLeaveRequestInput, CreateLeaveAdjustmentInput, CreateLeaveRequestInput, DecideLeaveRequestInput, LeaveAvailabilityInput, PutLeaveProfileInput, PutLeaveSettingsInput, UpdateLeaveRequestInput } from '@workloom/contracts';
import { ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { reportKeys } from '../generic-reports/queries';
import * as api from './api';
export const timeOffKeys = {
  root: (actorId: string, workspaceId: string) => [...queryKeys.workspace(actorId, workspaceId), 'time-off'] as const,
  overview: (actorId: string, workspaceId: string) => [...timeOffKeys.root(actorId, workspaceId), 'overview'] as const,
  availability: (actorId: string, workspaceId: string, input: LeaveAvailabilityInput | null) => [...timeOffKeys.root(actorId, workspaceId), 'availability', input] as const,
};
export function useTimeOffOverview(actorId: string, workspaceId: string) { return useQuery({ queryKey: timeOffKeys.overview(actorId, workspaceId), queryFn: ({ signal }) => api.fetchOverview(workspaceId, signal), staleTime: 30_000, refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false, retry: false }); }
export function useAvailability(actorId: string, workspaceId: string, input: LeaveAvailabilityInput | null) {
  return useQuery({ queryKey: timeOffKeys.availability(actorId, workspaceId, input), queryFn: ({ signal }) => { if (!input) throw new ApiError({ kind: 'invalid_input', status: null }); return api.fetchAvailability(workspaceId, input, signal); }, enabled: input !== null, retry: false });
}
export interface TimeOffAcknowledgements {
  onCreated?: () => void;
  onSettings?: (saved: LeaveSettingsDto) => void;
  onProfile?: (saved: LeaveProfileDto) => void;
  onRequest?: (saved: LeaveRequestDto) => void;
}
export function useTimeOffCommands(actorId: string, workspaceId: string, acknowledgements: TimeOffAcknowledgements = {}) {
  const client = useQueryClient();
  const invalidate = () => { void client.invalidateQueries({ queryKey: timeOffKeys.root(actorId, workspaceId) }); void client.invalidateQueries({ queryKey: reportKeys.root(actorId, workspaceId) }); };
  const template = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: ApplyLeaveTemplateInput }) => api.applyTemplateRequest(workspaceId, input), onSuccess: invalidate });
  const settings = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: PutLeaveSettingsInput }) => api.saveSettingsRequest(workspaceId, input), onSuccess: saved => { invalidate(); acknowledgements.onSettings?.(saved); } });
  const profile = useIdempotentMutation({ prepare: ({ membershipId, input }: IdempotentVariables & { membershipId: string; input: PutLeaveProfileInput }) => api.saveProfileRequest(workspaceId, membershipId, input), onSuccess: saved => { invalidate(); acknowledgements.onProfile?.(saved); } });
  const create = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: CreateLeaveRequestInput }) => api.createRequest(workspaceId, input), onSuccess: saved => { invalidate(); acknowledgements.onRequest?.(saved); acknowledgements.onCreated?.(); } });
  const update = useIdempotentMutation({ prepare: ({ requestId, input }: IdempotentVariables & { requestId: string; input: UpdateLeaveRequestInput }) => api.updateRequest(workspaceId, requestId, input), onSuccess: saved => { invalidate(); acknowledgements.onRequest?.(saved); } });
  const decision = useIdempotentMutation({ prepare: ({ requestId, input }: IdempotentVariables & { requestId: string; input: DecideLeaveRequestInput }) => api.decideRequest(workspaceId, requestId, input), onSuccess: saved => { invalidate(); acknowledgements.onRequest?.(saved); } });
  const bulk = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: BulkLeaveRequestInput }) => api.bulkRequest(workspaceId, input), onSuccess: saved => { invalidate(); for (const request of saved) acknowledgements.onRequest?.(request); acknowledgements.onCreated?.(); } });
  const adjustment = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: CreateLeaveAdjustmentInput }) => api.adjustmentRequest(workspaceId, input), onSuccess: invalidate });
  return { template, settings, profile, create, update, decision, bulk, adjustment };
}

export function useLeavePreview(actorId: string, workspaceId: string, input: PreviewLeaveRequestInput | null) { return useQuery({ queryKey: [...timeOffKeys.root(actorId, workspaceId), 'request-preview', input], queryFn: ({ signal }) => { if (!input) throw new ApiError({ kind: 'invalid_input', status: null }); return api.previewLeave(workspaceId, input, signal); }, enabled: input !== null, retry: false, staleTime: 0 }); }
export function useBulkLeavePreview(actorId: string, workspaceId: string, input: BulkLeaveRequestInput | null) { return useQuery({ queryKey: [...timeOffKeys.root(actorId, workspaceId), 'bulk-preview', input], queryFn: ({ signal }) => { if (!input) throw new ApiError({ kind: 'invalid_input', status: null }); return api.previewBulk(workspaceId, input, signal); }, enabled: input !== null, retry: false, staleTime: 0 }); }
export function useSettingsPreview(actorId: string, workspaceId: string, input: PutLeaveSettingsInput | null) { return useQuery({ queryKey: [...timeOffKeys.root(actorId, workspaceId), 'settings-preview', input], queryFn: ({ signal }) => { if (!input) throw new ApiError({ kind: 'invalid_input', status: null }); return api.previewSettings(workspaceId, input, signal); }, enabled: input !== null, retry: false, staleTime: 0 }); }
export function useProfilePreview(actorId: string, workspaceId: string, membershipId: string, input: PutLeaveProfileInput | null) { return useQuery({ queryKey: [...timeOffKeys.root(actorId, workspaceId), 'profile-preview', membershipId, input], queryFn: ({ signal }) => { if (!input) throw new ApiError({ kind: 'invalid_input', status: null }); return api.previewProfile(workspaceId, membershipId, input, signal); }, enabled: input !== null, retry: false, staleTime: 0 }); }
