import { leaveAdjustmentResponseSchema, leaveBulkPreviewResponseSchema, leaveRecalculationPreviewResponseSchema, leaveRequestPreviewResponseSchema, previewLeaveRequestInputSchema, type PreviewLeaveRequestInput, applyLeaveTemplateInputSchema, bulkLeaveRequestInputSchema, createLeaveAdjustmentInputSchema, createLeaveRequestInputSchema, decideLeaveRequestInputSchema, leaveAvailabilityInputSchema, leaveAvailabilityResponseSchema, leaveOverviewResponseSchema, leaveProfileResponseSchema, leaveRequestListResponseSchema, leaveRequestResponseSchema, leaveSettingsResponseSchema, putLeaveProfileInputSchema, putLeaveSettingsInputSchema, updateLeaveRequestInputSchema, type ApplyLeaveTemplateInput, type BulkLeaveRequestInput, type CreateLeaveAdjustmentInput, type CreateLeaveRequestInput, type DecideLeaveRequestInput, type LeaveAvailabilityInput, type PutLeaveProfileInput, type PutLeaveSettingsInput, type UpdateLeaveRequestInput } from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, prepareMutation, type ResponseParser } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
const path = (workspaceId: string) => `${workspacePath(workspaceId)}/time-off`;
export async function fetchOverview(workspaceId: string, signal?: AbortSignal) { return (await apiGet(`${path(workspaceId)}/overview`, leaveOverviewResponseSchema, signal)).data; }
export async function fetchAvailability(workspaceId: string, input: LeaveAvailabilityInput, signal?: AbortSignal) {
  const parsed = leaveAvailabilityInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(`${path(workspaceId)}/availability`, { method: 'POST', body: parsed.data, signal });
  const result = leaveAvailabilityResponseSchema.safeParse(response.payload);
  if (!result.success) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return result.data.data;
}
export function applyTemplateRequest(workspaceId: string, input: ApplyLeaveTemplateInput) { return prepareMutation({ method: 'POST', path: `${path(workspaceId)}/template`, input, inputSchema: applyLeaveTemplateInputSchema, responseSchema: leaveSettingsResponseSchema }); }
export function saveSettingsRequest(workspaceId: string, input: PutLeaveSettingsInput) { return prepareMutation({ method: 'PUT', path: `${path(workspaceId)}/settings`, input, inputSchema: putLeaveSettingsInputSchema, responseSchema: leaveSettingsResponseSchema }); }
export function saveProfileRequest(workspaceId: string, membershipId: string, input: PutLeaveProfileInput) { return prepareMutation({ method: 'PUT', path: `${path(workspaceId)}/members/${encodeURIComponent(membershipId)}/profile`, input, inputSchema: putLeaveProfileInputSchema, responseSchema: leaveProfileResponseSchema }); }
export function createRequest(workspaceId: string, input: CreateLeaveRequestInput) { return prepareMutation({ method: 'POST', path: `${path(workspaceId)}/requests`, input, inputSchema: createLeaveRequestInputSchema, responseSchema: leaveRequestResponseSchema }); }
export function updateRequest(workspaceId: string, requestId: string, input: UpdateLeaveRequestInput) { return prepareMutation({ method: 'PATCH', path: `${path(workspaceId)}/requests/${encodeURIComponent(requestId)}`, input, inputSchema: updateLeaveRequestInputSchema, responseSchema: leaveRequestResponseSchema }); }
export function decideRequest(workspaceId: string, requestId: string, input: DecideLeaveRequestInput) { return prepareMutation({ method: 'POST', path: `${path(workspaceId)}/requests/${encodeURIComponent(requestId)}/decision`, input, inputSchema: decideLeaveRequestInputSchema, responseSchema: leaveRequestResponseSchema }); }
export function bulkRequest(workspaceId: string, input: BulkLeaveRequestInput) { return prepareMutation({ method: 'POST', path: `${path(workspaceId)}/requests/bulk`, input, inputSchema: bulkLeaveRequestInputSchema, responseSchema: leaveRequestListResponseSchema }); }
// The committed adjustment ACK is independent of any later overview refresh.
export function adjustmentRequest(workspaceId: string, input: CreateLeaveAdjustmentInput) { return prepareMutation({ method: 'POST', path: `${path(workspaceId)}/adjustments`, input, inputSchema: createLeaveAdjustmentInputSchema, responseSchema: leaveAdjustmentResponseSchema }); }


async function readPreview<Input, Output>(url: string, input: Input, inputSchema: ResponseParser<Input>, outputSchema: ResponseParser<{ data: Output }>, signal?: AbortSignal): Promise<Output> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(url, { method: 'POST', body: parsed.data, signal });
  const output = outputSchema.safeParse(response.payload);
  if (!output.success) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return output.data.data;
}
export const previewLeave = (workspaceId: string, input: PreviewLeaveRequestInput, signal?: AbortSignal) => readPreview(`${path(workspaceId)}/preview`, input, previewLeaveRequestInputSchema, leaveRequestPreviewResponseSchema, signal);
export const previewBulk = (workspaceId: string, input: BulkLeaveRequestInput, signal?: AbortSignal) => readPreview(`${path(workspaceId)}/requests/bulk-preview`, input, bulkLeaveRequestInputSchema, leaveBulkPreviewResponseSchema, signal);
export const previewSettings = (workspaceId: string, input: PutLeaveSettingsInput, signal?: AbortSignal) => readPreview(`${path(workspaceId)}/settings/preview`, input, putLeaveSettingsInputSchema, leaveRecalculationPreviewResponseSchema, signal);
export const previewProfile = (workspaceId: string, membershipId: string, input: PutLeaveProfileInput, signal?: AbortSignal) => readPreview(`${path(workspaceId)}/members/${encodeURIComponent(membershipId)}/profile/preview`, input, putLeaveProfileInputSchema, leaveRecalculationPreviewResponseSchema, signal);
