import type { CallbackTokens } from './authApi';

/** Defined only by the inline script in index.html, on the callback path, for one call. */
export const AUTH_CALLBACK_HANDOFF = '__workloomTakeAuthCallback';
/** Same bound the inline script applies to each fragment value. */
export const MAX_CALLBACK_TOKEN_LENGTH = 16_384;

function boundedToken(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CALLBACK_TOKEN_LENGTH ? value : null;
}

export function parseCallbackTokens(value: unknown): CallbackTokens | null {
  if (typeof value !== 'object' || value === null) return null;
  const accessToken = boundedToken(Reflect.get(value, 'accessToken'));
  const refreshToken = boundedToken(Reflect.get(value, 'refreshToken'));
  const state = boundedToken(Reflect.get(value, 'state'));
  return accessToken && refreshToken && state ? { accessToken, refreshToken, state } : null;
}

/**
 * Takes the tokens the inline script captured, at most once per page load. The handoff is
 * removed even when it is missing or yields nothing usable, so no later code can read it.
 */
export function takeAuthCallback(target: object = window): CallbackTokens | null {
  const take: unknown = Reflect.get(target, AUTH_CALLBACK_HANDOFF);
  Reflect.deleteProperty(target, AUTH_CALLBACK_HANDOFF);
  if (typeof take !== 'function') return null;
  try {
    return parseCallbackTokens(Reflect.apply(take, undefined, []));
  } catch {
    return null;
  }
}
