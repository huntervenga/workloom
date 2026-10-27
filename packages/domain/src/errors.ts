/**
 * Typed domain errors. Adapters (HTTP, MCP, jobs) translate these codes into
 * their transport; the domain never knows about HTTP status codes.
 *
 * Codes follow docs/04-api-and-integrations.md section 5.
 */
export const DOMAIN_ERROR_CODES = [
  'ATTACHMENT_LIMIT_REACHED',
  'VALIDATION_FAILED',
  'LEAVE_CALCULATION_LIMIT',
  'UNAUTHENTICATED',
  'CAPABILITY_REQUIRED',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'FIELD_LOCKED',
  'PERIOD_CLOSED',
  'DEPENDENCY_CYCLE',
  'SOURCE_ALREADY_ACCOUNTED',
  'PREVIEW_STALE',
  'IDEMPOTENCY_KEY_REUSED',
  'OPERATION_IN_PROGRESS',
  'DOMAIN_VALIDATION_FAILED',
  'PLAN_VALUE_UNRESOLVED',
  'MATERIALIZATION_REQUIRED',
  'RATE_LIMITED',
  'TEMPORARILY_UNAVAILABLE',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

const RETRYABLE_BY_DEFAULT: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  'OPERATION_IN_PROGRESS',
  'RATE_LIMITED',
  'TEMPORARILY_UNAVAILABLE',
]);

export interface DomainErrorOptions {
  /** Safe, client-visible details. Never put hidden object names, SQL or secrets here. */
  readonly details?: unknown;
  readonly retryable?: boolean;
  /** Internal cause for logs; never serialized to clients. */
  readonly cause?: unknown;
}

const DOMAIN_ERROR_BRAND = Symbol.for('workloom.domain.DomainError');

export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: DomainErrorCode;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(code: DomainErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    Object.defineProperty(this, DOMAIN_ERROR_BRAND, { value: true, enumerable: false });
  }
}

/**
 * Brand-based check so that errors survive duplicated module instances
 * (for example a source copy under a test runner and a built copy in dist).
 */
export function isDomainError(value: unknown): value is DomainError {
  return (
    value instanceof DomainError ||
    (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[DOMAIN_ERROR_BRAND] === true)
  );
}

/** The single not-found message: absent and invisible objects must look identical. */
export const NOT_FOUND_MESSAGE = 'The requested resource was not found.';

export function notFoundError(): DomainError {
  return new DomainError('NOT_FOUND', NOT_FOUND_MESSAGE);
}

export function capabilityRequiredError(): DomainError {
  return new DomainError('CAPABILITY_REQUIRED', 'This operation is not permitted for the current member.');
}

export function unauthenticatedError(message = 'No valid identity is available for this request.'): DomainError {
  return new DomainError('UNAUTHENTICATED', message);
}

export function temporarilyUnavailableError(cause?: unknown): DomainError {
  return new DomainError(
    'TEMPORARILY_UNAVAILABLE',
    'The service is temporarily unavailable. Retry the request.',
    cause === undefined ? {} : { cause },
  );
}
