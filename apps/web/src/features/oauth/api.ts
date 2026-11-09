import { envelopeSchema, oauthConsentSchema, oauthDecisionInputSchema, oauthDecisionSchema, type OAuthDecisionInput } from '@workloom/contracts';
import { apiGet, prepareMutation, sendMutation } from '../../lib/api';

const base = '/api/v1/oauth/authorize';

/** `request` is the authorization query string the connecting app sent, without the leading "?". */
export async function fetchConsent(request: string, signal?: AbortSignal) {
  return (await apiGet(`${base}?${request}`, envelopeSchema(oauthConsentSchema), signal)).data;
}

export function decideConsent(input: OAuthDecisionInput) {
  const prepared = prepareMutation({ method: 'POST', path: base, input, inputSchema: oauthDecisionInputSchema, responseSchema: envelopeSchema(oauthDecisionSchema) });
  return sendMutation(prepared, { idempotencyKey: crypto.randomUUID() }).then(result => result.data);
}
