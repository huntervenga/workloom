import { finishAuthSession, type CallbackTokens } from './authApi';

export type CallbackOutcome = { kind: 'signed_in'; returnTo: string } | { kind: 'invalid' } | { kind: 'failed' };

/**
 * Starts the single token exchange for this page load, outside React so no render or effect
 * can send it again. The promise never rejects and keeps no error details; missing tokens send nothing.
 */
export function startCallbackExchange(tokens: CallbackTokens | null): Promise<CallbackOutcome> {
  if (!tokens) return Promise.resolve<CallbackOutcome>({ kind: 'invalid' });
  return finishAuthSession(tokens).then(
    (returnTo): CallbackOutcome => ({ kind: 'signed_in', returnTo }),
    (): CallbackOutcome => ({ kind: 'failed' }),
  );
}
