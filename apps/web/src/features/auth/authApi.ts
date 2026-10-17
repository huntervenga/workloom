import { meResponseSchema } from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, isRecord, type ResponseParser } from '../../lib/api';
import { parseCallbackTokens } from './callbackHandoff';

export type AuthMode = 'dev' | 'shared';

/** Tokens from the sign-in callback fragment. They live in memory only until the one exchange. */
export interface CallbackTokens {
  accessToken: string;
  refreshToken: string;
  state: string;
}

export const APP_HOME = '/app';
export const AUTH_CALLBACK_PATH = '/app/auth/callback';
export const MAX_RETURN_TO_LENGTH = 2048;

const CONFIG_PATH = '/api/v1/auth/config';
const LOGIN_PATH = '/api/v1/auth/login';
const SESSION_PATH = '/api/v1/auth/session';
const LOGOUT_PATH = '/api/v1/auth/logout';
const ME_PATH = '/api/v1/me';

// Only used to resolve relative paths; any result on another origin is rejected.
const PROBE_ORIGIN = 'https://workloom.invalid';
const TOKEN_NAME = /(?:access|refresh|id)[_-]?token/i;
const TOKEN_KEY = /^(?:access|refresh|id|auth)[_-]?token$/i;

function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Controls, spaces and backslashes never appear in a path the browser reports. */
function hasUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) return true;
  }
  return false;
}

function isCallbackPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return [pathname, decoded].some((candidate) =>
    isUnder(candidate.toLowerCase().replace(/\/{2,}/g, '/'), AUTH_CALLBACK_PATH),
  );
}

/**
 * Reduces any value to a path under /app on this origin (with its query and hash), or /app.
 * External URLs, lookalikes such as /apple, the callback itself and token-bearing addresses are refused.
 */
export function boundedReturnTo(value: string): string {
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH || hasUnsafeCharacter(value)) return APP_HOME;
  if (!(value === APP_HOME || ['/', '?', '#'].some((next) => value.startsWith(`${APP_HOME}${next}`)))) return APP_HOME;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return APP_HOME;
  }
  if (url.origin !== PROBE_ORIGIN || !isUnder(url.pathname, APP_HOME) || isCallbackPath(url.pathname)) return APP_HOME;
  if (TOKEN_NAME.test(url.search) || TOKEN_NAME.test(url.hash)) return APP_HOME;

  const bounded = `${url.pathname}${url.search}${url.hash}`;
  return bounded.length <= MAX_RETURN_TO_LENGTH ? bounded : APP_HOME;
}

/** Same-origin sign-in endpoint; open it with a top-level navigation. */
export function loginHref(returnTo: string): string {
  return `${LOGIN_PATH}?returnTo=${encodeURIComponent(boundedReturnTo(returnTo))}`;
}

function dataOf(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const data = payload['data'];
  return isRecord(data) ? data : null;
}

/** Session responses rely on the HttpOnly cookie; any token in a body means it is not the expected one. */
function mentionsToken(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => mentionsToken(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => TOKEN_KEY.test(key) || mentionsToken(item, depth + 1));
}

const authConfigResponse: ResponseParser<AuthMode> = {
  safeParse(input) {
    const mode = dataOf(input)?.['authMode'];
    return mode === 'dev' || mode === 'shared' ? { success: true, data: mode } : { success: false };
  },
};

export function fetchAuthMode(signal?: AbortSignal): Promise<AuthMode> {
  return apiGet(CONFIG_PATH, authConfigResponse, signal);
}

/**
 * Exchanges the callback tokens for the session cookie with one POST and no retry: a lost
 * answer may still have signed the user in, so callers offer checkSession instead of resending.
 */
export async function finishAuthSession(tokens: CallbackTokens): Promise<string> {
  const checked = parseCallbackTokens(tokens);
  if (!checked) throw new ApiError({ kind: 'invalid_input', status: null });
  const { status, payload } = await apiRequest(SESSION_PATH, {
    method: 'POST',
    body: { accessToken: checked.accessToken, refreshToken: checked.refreshToken, state: checked.state },
  });
  const returnTo = dataOf(payload)?.['returnTo'];
  if (typeof returnTo !== 'string' || mentionsToken(payload)) {
    throw new ApiError({ kind: 'invalid_response', status });
  }
  return boundedReturnTo(returnTo);
}

export async function logoutSession(): Promise<void> {
  const { status } = await apiRequest(LOGOUT_PATH, { method: 'POST' });
  if (status !== 204) throw new ApiError({ kind: 'invalid_response', status });
}

/** Resolves only when the server confirms a signed-in identity. */
export async function checkSession(signal?: AbortSignal): Promise<void> {
  const { status, payload } = await apiRequest(ME_PATH, { signal });
  if (mentionsToken(payload) || !meResponseSchema.safeParse(payload).success) {
    throw new ApiError({ kind: 'invalid_response', status });
  }
}
