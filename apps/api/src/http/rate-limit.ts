/**
 * A small in-process fixed-window limiter for the bearer-only surfaces (public API and MCP). It bounds how hard one token
 * or one address can drive this process. It is per process: behind several instances each one counts for itself.
 *
 * Once every named slot is occupied by a live window, unseen keys share one bounded overflow window. Never evict a live
 * counter: doing that would let an attacker rotate keys and reset its own limit.
 */
export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Upper bound on remembered named keys. Unseen keys share a separate overflow window while every slot is live. */
  readonly maxKeys?: number;
}
export interface RateDecision { readonly allowed: boolean; readonly retryAfterSeconds: number }

export function createRateLimiter(options: RateLimiterOptions, now: () => number = Date.now) {
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let overflow: { count: number; resetAt: number } | undefined;
  const charge = (entry: { count: number; resetAt: number }, at: number, cost: number): RateDecision => {
    entry.count += cost;
    return entry.count <= options.limit
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) };
  };
  return {
    /** `cost` lets a JSON-RPC batch consume one unit per enclosed message. */
    check(key: string, cost = 1): RateDecision {
      if (!Number.isSafeInteger(cost) || cost < 1) throw new Error('Rate-limit cost must be a positive safe integer.');
      const at = now();
      let entry = windows.get(key);
      if (entry?.resetAt !== undefined && entry.resetAt <= at) { windows.delete(key); entry = undefined; }
      if (entry) return charge(entry, at, cost);

      for (const [other, value] of windows) if (value.resetAt <= at) windows.delete(other);
      if (windows.size < maxKeys) {
        entry = { count: 0, resetAt: at + options.windowMs };
        windows.set(key, entry);
        return charge(entry, at, cost);
      }

      if (!overflow || overflow.resetAt <= at) overflow = { count: 0, resetAt: at + options.windowMs };
      return charge(overflow, at, cost);
    },
  };
}

export interface PublicRateLimiterOptions {
  readonly addressLimit: number;
  readonly tokenLimit: number;
  readonly windowMs: number;
  readonly maxKeys?: number;
}

/**
 * Applies an address ceiling to every bearer-only request and a second, tighter ceiling to each presented token.
 * The address check intentionally runs first so rotating valid-looking but unknown tokens cannot bypass the limiter.
 */
export function createPublicRateLimiter(options: PublicRateLimiterOptions, now: () => number = Date.now) {
  const limiterOptions = { windowMs: options.windowMs, ...(options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys }) };
  const addresses = createRateLimiter({ ...limiterOptions, limit: options.addressLimit }, now);
  const tokens = createRateLimiter({ ...limiterOptions, limit: options.tokenLimit }, now);
  return {
    check(address: string, tokenKey: string | undefined, cost = 1): RateDecision {
      const addressDecision = addresses.check(address, cost);
      if (!addressDecision.allowed || tokenKey === undefined) return addressDecision;
      return tokens.check(tokenKey, cost);
    },
  };
}
