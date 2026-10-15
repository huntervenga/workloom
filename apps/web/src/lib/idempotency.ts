/** A fresh random UUID v4 for one write operation. */
export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

  // randomUUID needs a secure context; getRandomValues does not.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JSON with object keys sorted, so equal payloads always compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

/**
 * A different write was refused before sending because an earlier one has an
 * unknown outcome. Nothing was sent.
 */
export class UncertainCommandError extends Error {
  constructor() {
    super('An earlier write has an unknown outcome; resend it unchanged before sending another.');
    this.name = 'UncertainCommandError';
  }
}

/**
 * A write was refused before sending because the same write hook is still waiting for the
 * answer to an earlier one. Nothing was sent and the earlier command is unaffected.
 */
export class PendingCommandError extends Error {
  constructor() {
    super('An earlier write is still waiting for an answer; wait for it before sending another.');
    this.name = 'PendingCommandError';
  }
}

interface PendingOperation {
  fingerprint: string;
  key: string;
  /** Sent without a confirmed answer: it may have been committed. */
  uncertain: boolean;
}

/**
 * Holds the Idempotency-Key of the operation the user is submitting. Sending
 * an identical request again after a failure reuses the key, so the server can
 * recognize the retry. After a confirmed rejection a different request starts a
 * new operation with a new key; while the outcome is unknown, only the exact
 * request with its key may be sent. Nothing here resends anything by itself.
 */
export class IdempotencyKeyTracker {
  private pending: PendingOperation | null = null;

  get uncertain(): boolean {
    return this.pending?.uncertain ?? false;
  }

  /** Throws `UncertainCommandError` for any other request while the outcome is unknown. */
  keyFor(fingerprint: string, preferredKey?: string): string {
    const current = this.pending;
    if (current !== null && current.fingerprint === fingerprint && (preferredKey === undefined || preferredKey === current.key)) {
      return current.key;
    }
    if (current?.uncertain) throw new UncertainCommandError();
    const next = { fingerprint, key: preferredKey ?? createIdempotencyKey(), uncertain: false };
    this.pending = next;
    return next.key;
  }

  /** Records a failed send; `uncertain` when the server may still have committed it. */
  fail(fingerprint: string, uncertain: boolean): void {
    if (this.pending?.fingerprint === fingerprint) this.pending = { ...this.pending, uncertain };
  }

  /** Forget the key once the server has confirmed this request. */
  complete(fingerprint: string): void {
    if (this.pending?.fingerprint === fingerprint) this.pending = null;
  }
}
