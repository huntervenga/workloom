/**
 * Classification and log-safe description of database errors. Pure helpers
 * with no domain imports so the CLIs can use them without building the domain.
 */

/** SQLSTATE classes/codes after which a retry may succeed or the server is not ready. */
const UNAVAILABLE_SQLSTATES = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '3D000', // invalid_catalog_name (database missing)
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  '42P01', // undefined_table (schema not migrated)
]);

const UNAVAILABLE_CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 6 && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** First string `code` in the error/cause chain (SQLSTATE or connection code). */
export function databaseErrorCode(error: unknown): string | undefined {
  for (const item of errorChain(error)) {
    const code = typeof item === 'object' && item !== null ? (item as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return undefined;
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return (
    code !== undefined &&
    (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_CONNECTION_CODES.has(code) || code.startsWith('08'))
  );
}

function isDatabaseError(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) {
    return false;
  }
  const record = item as Record<string, unknown>;
  // DrizzleQueryError embeds the SQL text and bound parameters in its message;
  // postgres.js errors may name the database user.
  return (
    ('query' in record && 'params' in record) ||
    record.name === 'PostgresError' ||
    (typeof record.code === 'string' && (/^[0-9A-Z]{5}$/.test(record.code) || UNAVAILABLE_CONNECTION_CODES.has(record.code)))
  );
}

export interface LoggableError {
  readonly type: string;
  readonly code?: string;
  /** Present only for non-database errors, whose messages carry no query parameters. */
  readonly message?: string;
}

/** A log-safe summary: database error messages (SQL, parameters, user names) are dropped. */
export function describeErrorForLog(error: unknown): LoggableError {
  const chain = errorChain(error);
  const code = databaseErrorCode(error);
  const type = error instanceof Error ? error.name : typeof error;
  if (chain.some(isDatabaseError)) {
    return code === undefined ? { type: 'DatabaseError' } : { type: 'DatabaseError', code };
  }
  const message = error instanceof Error ? error.message : undefined;
  return {
    type,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}
