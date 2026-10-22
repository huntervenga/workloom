/**
 * A small in-process fixed-window limiter for the bearer-only surfaces (public API and MCP). It bounds how hard one token,
 * or one address without a valid-looking token, can drive the database. It is per process: behind several instances each
 * one counts for itself, which still caps the total at instances × limit.
 */
export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Upper bound on remembered keys; older windows are dropped first so the map cannot grow without bound. */
  readonly maxKeys?: number;
}
export interface RateDecision { readonly allowed: boolean; readonly retryAfterSeconds: number }

export function createRateLimiter(options: RateLimiterOptions, now: () => number = Date.now) {
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string): RateDecision {
      const at = now();
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= at) {
        if (windows.size >= maxKeys) {
          for (const [other, value] of windows) if (value.resetAt <= at) windows.delete(other);
          // Still full of live windows: forget the oldest one rather than refuse everyone.
          if (windows.size >= maxKeys) { const oldest = windows.keys().next(); if (!oldest.done) windows.delete(oldest.value); }
        }
        entry = { count: 0, resetAt: at + options.windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= options.limit ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) };
    },
  };
}
