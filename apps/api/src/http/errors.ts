import { isDatabaseUnavailableError } from '@workloom/db';
import { isDomainError, type DomainErrorCode } from '@workloom/domain';
import { RECURRENCE_ERROR_HTTP_STATUS, type ErrorResponseDto } from '@workloom/contracts';

export const DOMAIN_ERROR_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  // Contract-owned controlled 409 MATERIALIZATION_REQUIRED; recovery goes through recurrence-readiness.
  ...RECURRENCE_ERROR_HTTP_STATUS,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  CAPABILITY_REQUIRED: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  FIELD_LOCKED: 409,
  PERIOD_CLOSED: 409,
  DEPENDENCY_CYCLE: 409,
  SOURCE_ALREADY_ACCOUNTED: 409,
  PREVIEW_STALE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  OPERATION_IN_PROGRESS: 409,
  DOMAIN_VALIDATION_FAILED: 422,
  PLAN_VALUE_UNRESOLVED: 422,
  RATE_LIMITED: 429,
  TEMPORARILY_UNAVAILABLE: 503,
};

/** Transport-level rejection raised by the HTTP adapter itself (guards, parsing). */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface MappedError {
  readonly statusCode: number;
  readonly body: Omit<ErrorResponseDto, 'meta'>;
  /** True when the error is unexpected and should be logged as an error. */
  readonly unexpected: boolean;
}

function body(code: string, message: string, retryable: boolean, details?: Record<string, unknown>): MappedError['body'] {
  return { error: details === undefined ? { code, message, retryable } : { code, message, details, retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps any thrown value to a sanitized client error. Messages of unexpected
 * errors, SQL, stack traces and inputs are never returned.
 */
export function mapError(error: unknown): MappedError {
  if (isDomainError(error)) {
    const details = isRecord(error.details) ? error.details : undefined;
    return { statusCode: DOMAIN_ERROR_STATUS[error.code], body: body(error.code, error.message, error.retryable, details), unexpected: false };
  }
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, body: body(error.code, error.message, false, error.details), unexpected: false };
  }
  if (isDatabaseUnavailableError(error)) {
    return {
      statusCode: 503,
      body: body('TEMPORARILY_UNAVAILABLE', 'The service is temporarily unavailable. Retry the request.', true),
      unexpected: false,
    };
  }

  const fastifyCode = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  const statusCode = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : undefined;
  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return { statusCode: 413, body: body('PAYLOAD_TOO_LARGE', 'The request body is too large.', false), unexpected: false };
  }
  if (fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return { statusCode: 415, body: body('UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.', false), unexpected: false };
  }
  if (fastifyCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
    // Declared Content-Length does not match the body: a malformed request, not a media-type problem.
    return { statusCode: 400, body: body('BAD_REQUEST', 'The request is malformed.', false), unexpected: false };
  }
  if (statusCode === 400 || fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' || fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return { statusCode: 400, body: body('VALIDATION_FAILED', 'The request is invalid.', false), unexpected: false };
  }
  if (statusCode !== undefined && statusCode > 400 && statusCode < 500) {
    return { statusCode, body: body('BAD_REQUEST', 'The request could not be processed.', false), unexpected: false };
  }
  return { statusCode: 500, body: body('INTERNAL_ERROR', 'An unexpected error occurred.', false), unexpected: true };
}
