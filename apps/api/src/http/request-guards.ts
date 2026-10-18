import { HttpError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

export interface RequestGuardOptions {
  /** Port the API actually listens on (resolved after listen when configured as 0). */
  readonly hosted?: boolean;
  readonly getPort: () => number;
  /** Extra trusted browser origins, e.g. the Vite dev server. */
  readonly appOrigins: readonly string[];
}

export interface GuardedRequest {
  readonly method: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

/** Host names (with port) the API answers to: its own loopback names plus trusted app origins (proxied Host). */
export function allowedHosts(options: RequestGuardOptions): Set<string> {
  const port = options.getPort();
  const hosts = new Set(options.hosted === true ? [] : LOOPBACK_NAMES.map((name) => `${name}:${port}`));
  for (const origin of options.appOrigins) hosts.add(new URL(origin).host);
  return hosts;
}

export function trustedOrigins(options: RequestGuardOptions): Set<string> {
  const port = options.getPort();
  return new Set([...(options.hosted === true ? [] : LOOPBACK_NAMES.map((name) => `http://${name}:${port}`)), ...options.appOrigins]);
}

/**
 * DNS-rebinding guard for every request: Host must be a loopback name with an
 * expected port. Compared as an exact lower-cased string; malformed values are
 * simply rejected without parsing.
 */
export function assertAllowedHost(request: GuardedRequest, options: RequestGuardOptions): void {
  const host = single(request.headers.host)?.toLowerCase();
  if (options.hosted === true && host === 'healthcheck.railway.app' &&
    (request.method === 'GET' || request.method === 'HEAD') && request.url === '/healthz/ready') return;
  if (host === undefined || !allowedHosts(options).has(host)) {
    throw new HttpError(421, 'HOST_NOT_ALLOWED', 'This server only answers requests addressed to its configured origin.');
  }
}

/**
 * Cross-site guard for state-changing requests: Origin must be present and
 * exactly one of the trusted origins; a cross-site Fetch-Metadata hint is refused.
 * No CORS headers are ever emitted.
 */
export function assertTrustedOrigin(request: GuardedRequest, options: RequestGuardOptions): void {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = single(request.headers.origin);
  const fetchSite = single(request.headers['sec-fetch-site']);
  if (origin === undefined || !trustedOrigins(options).has(origin) || fetchSite === 'cross-site') {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'State-changing requests must come from the Workloom origin.');
  }
}
