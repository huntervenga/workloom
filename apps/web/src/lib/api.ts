import { errorResponseSchema } from '@workloom/contracts';
import { isUuid } from './format';
import { canonicalJson } from './idempotency';

export type ApiErrorKind =
  | 'network'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'server'
  | 'invalid_response'
  /** Rejected by the shared input schema before anything was sent. */
  | 'invalid_input';

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Client-side view of a failed request. It keeps only the status, a machine
 * code and the request ID; server messages and bodies are never retained, so
 * nothing from them can leak into the UI or logs.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(init: { kind: ApiErrorKind; status: number | null; code?: string | null; requestId?: string | null }) {
    super(`Workloom API request failed: ${init.kind}${init.status === null ? '' : ` (${init.status})`}`);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
  }
}

export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'forbidden' || error.kind === 'not_found');
}

/** Failures after which a sent write may still have been committed: no confirmed answer arrived. */
const UNCERTAIN_KINDS: ReadonlySet<ApiErrorKind> = new Set(['network', 'server', 'unavailable', 'invalid_response']);

export function isUncertainOutcome(error: unknown): error is ApiError {
  return error instanceof ApiError && UNCERTAIN_KINDS.has(error.kind);
}

/** Structural subset of a Zod schema, so callers can pass contract schemas directly. */
export interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export type ApiMethod = 'GET' | 'POST' | 'PATCH';
export type MutationMethod = Exclude<ApiMethod, 'GET'>;

export interface ApiRequestOptions {
  method?: ApiMethod | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

export interface ApiResponse {
  status: number;
  payload: unknown;
}

export async function apiRequest(path: string, options: ApiRequestOptions = {}): Promise<ApiResponse> {
  const { method = 'GET', body, headers, signal } = options;
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signal) init.signal = signal;

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    // Let cancellation propagate untouched so TanStack Query treats it as such.
    if (signal?.aborted) throw error;
    throw new ApiError({ kind: 'network', status: null });
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const envelope = readErrorEnvelope(payload);
    throw new ApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      code: safeToken(envelope.code, SAFE_CODE),
      requestId: safeToken(envelope.requestId ?? response.headers.get('x-request-id'), SAFE_REQUEST_ID),
    });
  }
  return { status: response.status, payload };
}

export async function apiGet<T>(path: string, parser: ResponseParser<T>, signal?: AbortSignal): Promise<T> {
  const { status, payload } = await apiRequest(path, { signal });
  return parseResponse(parser, status, payload);
}

/** A validated write, ready to send. Building it never touches the network. */
export interface MutationRequest<TResponse> {
  readonly method: MutationMethod;
  readonly path: string;
  /** The input as the shared schema parsed it (for example with names trimmed). */
  readonly body: unknown;
  readonly responseSchema: ResponseParser<TResponse>;
  /** Method, path and canonical body: identical requests share it. */
  readonly fingerprint: string;
}

export interface PrepareMutationInit<TInput, TResponse> {
  method: MutationMethod;
  path: string;
  input: TInput;
  /** A strict @workloom/contracts input schema. */
  inputSchema: ResponseParser<unknown>;
  responseSchema: ResponseParser<TResponse>;
}

/** Validates `input` against the shared schema; invalid input is never sent. */
export function prepareMutation<TInput, TResponse>(init: PrepareMutationInit<TInput, TResponse>): MutationRequest<TResponse> {
  const parsed = init.inputSchema.safeParse(init.input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  return {
    method: init.method,
    path: init.path,
    body: parsed.data,
    responseSchema: init.responseSchema,
    fingerprint: `${init.method} ${init.path} ${canonicalJson(parsed.data)}`,
  };
}

export interface MutationOptions {
  /**
   * UUID created when the user submitted this operation. Pass the same key to
   * retry an identical request; never mint a new one for a retry.
   */
  idempotencyKey: string;
  signal?: AbortSignal | undefined;
}

/**
 * Sends a prepared write exactly once: no automatic retries. The actor is
 * resolved by the server, so no identity headers are added here.
 */
export async function sendMutation<TResponse>(
  request: MutationRequest<TResponse>,
  { idempotencyKey, signal }: MutationOptions,
): Promise<TResponse> {
  if (!isUuid(idempotencyKey)) throw new TypeError('A mutation needs a UUID Idempotency-Key.');
  const { status, payload } = await apiRequest(request.path, {
    method: request.method,
    body: request.body,
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
  });
  return parseResponse(request.responseSchema, status, payload);
}

export async function apiMutate<TInput, TResponse>(
  init: PrepareMutationInit<TInput, TResponse>,
  options: MutationOptions,
): Promise<TResponse> {
  return sendMutation(prepareMutation(init), options);
}

function parseResponse<T>(parser: ResponseParser<T>, status: number, payload: unknown): T {
  const parsed = parser.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({ kind: 'invalid_response', status });
  }
  return parsed.data;
}

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'server';
  return 'validation';
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return undefined;
  try {
    const payload: unknown = await response.json();
    return payload;
  } catch {
    return undefined;
  }
}

function readErrorEnvelope(payload: unknown): { code: unknown; requestId: unknown } {
  const parsed = errorResponseSchema.safeParse(payload);
  if (!parsed.success) return { code: null, requestId: null };
  const envelope: unknown = parsed.data;
  const error = isRecord(envelope) ? envelope['error'] : undefined;
  const meta = isRecord(envelope) ? envelope['meta'] : undefined;
  return {
    code: isRecord(error) ? error['code'] : null,
    requestId: isRecord(meta) ? meta['requestId'] : null,
  };
}

function safeToken(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
