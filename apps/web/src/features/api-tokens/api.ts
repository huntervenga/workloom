import { apiTokenSchema, createApiTokenInputSchema, createdApiTokenSchema, envelopeSchema, type CreateApiTokenInput } from '@workloom/contracts';
import { z } from 'zod';
import { apiGet, prepareMutation, sendMutation } from '../../lib/api';

const base = '/api/v1/me/api-tokens';
const listSchema = envelopeSchema(apiTokenSchema.array());

export async function fetchApiTokens(signal?: AbortSignal) {
  return (await apiGet(base, listSchema, signal)).data;
}
export function createApiToken(input: CreateApiTokenInput) {
  const request = prepareMutation({ method: 'POST', path: base, input, inputSchema: createApiTokenInputSchema, responseSchema: envelopeSchema(createdApiTokenSchema) });
  return sendMutation(request, { idempotencyKey: crypto.randomUUID() }).then(result => result.data);
}
export function revokeApiToken(id: string) {
  const request = prepareMutation({ method: 'POST', path: `${base}/${encodeURIComponent(id)}/revoke`, input: {}, inputSchema: z.strictObject({}), responseSchema: envelopeSchema(apiTokenSchema) });
  return sendMutation(request, { idempotencyKey: crypto.randomUUID() }).then(result => result.data);
}
