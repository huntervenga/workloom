// Test-only stand-in for the shared Auth provider (RS256/JWKS, aud=pet-projects) used by native
// private-QA specs. Real node:crypto keys and signatures, in-memory state, bound to 127.0.0.1 only.
// The account chooser is explicitly a private test identity picker, not Google sign-in.
import { createSign, createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface FakeSharedAuthIdentity {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface RegisteredFakeSharedAuthIdentity extends FakeSharedAuthIdentity {
  readonly buttonName: string;
}

export interface FakeSharedAuthStats {
  readonly logins: number;
  readonly completedLogins: number;
  readonly refreshes: number;
  readonly refreshRejects: number;
  readonly logouts: number;
  readonly meReads: number;
  readonly jwksReads: number;
}

export interface FakeSharedAuth {
  readonly origin: string;
  readonly identities: { readonly a: FakeSharedAuthIdentity; readonly b: FakeSharedAuthIdentity };
  /** Adds a fresh subject without replacing the provider key/JWKS used by the running API. */
  registerIdentity(label: string): RegisteredFakeSharedAuthIdentity;
  stats(): FakeSharedAuthStats;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PRIVATE_QA_APP_ORIGIN = 'http://127.0.0.1:49318';
const PRIVATE_QA_PORT = 49319;
const AUDIENCE = 'pet-projects';
const CALLBACK_PATH = '/app/auth/callback';
const TOKEN_TTL_SECONDS = 900;
const TICKET_TTL_MS = 5 * 60_000;
const MAX_STATE_LENGTH = 4096;
const MAX_BODY_BYTES = 16 * 1024;
const QA_EMAIL = 'qa-shared-auth@gmail.com';
const QA_NAME = 'QA Shared Auth';

const b64json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const opaque = (): string => randomBytes(32).toString('base64url');
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function send(res: ServerResponse, status: number, body?: unknown, contentType = 'application/json'): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': `${contentType}; charset=utf-8` }).end(payload);
}

async function readRefreshToken(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Drain instead of breaking out so the socket survives long enough to answer 400.
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= MAX_BODY_BYTES) chunks.push(buffer);
  }
  if (size > MAX_BODY_BYTES) return null;
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = isRecord(body) ? body['refresh_token'] : undefined;
    return typeof token === 'string' && token.length > 0 && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

export async function startFakeSharedAuth(options: { port: number; appOrigin: string }): Promise<FakeSharedAuth> {
  const { port, appOrigin } = options;
  if (port !== PRIVATE_QA_PORT || appOrigin !== PRIVATE_QA_APP_ORIGIN) {
    throw new Error(`Fake shared auth only runs on ${HOST}:${PRIVATE_QA_PORT} for app ${PRIVATE_QA_APP_ORIGIN}`);
  }
  const origin = `http://${HOST}:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const observedAt = new Date().toISOString();
  const identities = {
    a: { id: randomUUID(), email: QA_EMAIL, name: QA_NAME },
    b: { id: randomUUID(), email: QA_EMAIL, name: QA_NAME },
  } as const satisfies Record<'a' | 'b', FakeSharedAuthIdentity>;
  const identityById = new Map<string, FakeSharedAuthIdentity>([
    [identities.a.id, identities.a],
    [identities.b.id, identities.b],
  ]);
  const accounts = new Map<string, { identity: FakeSharedAuthIdentity; buttonName: string }>([
    ['a', { identity: identities.a, buttonName: 'Continue as account A' }],
    ['b', { identity: identities.b, buttonName: 'Continue as account B' }],
  ]);
  const tickets = new Map<string, { callback: string; state: string; expiresAt: number }>();
  const refreshTokens = new Map<string, FakeSharedAuthIdentity>();
  const counters = { logins: 0, completedLogins: 0, refreshes: 0, refreshRejects: 0, logouts: 0, meReads: 0, jwksReads: 0 };

  function signAccessToken(identity: FakeSharedAuthIdentity): string {
    const iat = Math.floor(Date.now() / 1000);
    const input = `${b64json({ alg: 'RS256', typ: 'JWT', kid })}.${b64json({
      iss: origin,
      aud: AUDIENCE,
      sub: identity.id,
      email: identity.email,
      name: identity.name,
      iat,
      exp: iat + TOKEN_TTL_SECONDS,
      email_verified: true,
      email_verification_assertion: 'google_gmail',
      email_verification_observed_at: observedAt,
    })}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
  }

  function verifyAccessToken(token: string): FakeSharedAuthIdentity | null {
    const [header, payload, signature, ...rest] = token.split('.');
    if (!header || !payload || !signature || rest.length > 0) return null;
    try {
      const head: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      if (!isRecord(head) || head['alg'] !== 'RS256' || head['kid'] !== kid) return null;
      const valid = createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, 'base64url'));
      if (!valid) return null;
      const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!isRecord(claims) || claims['iss'] !== origin || claims['aud'] !== AUDIENCE) return null;
      const exp = claims['exp'];
      if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) return null;
      const sub = claims['sub'];
      return typeof sub === 'string' ? (identityById.get(sub) ?? null) : null;
    } catch {
      return null;
    }
  }

  function issueTokens(identity: FakeSharedAuthIdentity) {
    const refreshToken = opaque();
    refreshTokens.set(refreshToken, identity);
    return { access_token: signAccessToken(identity), refresh_token: refreshToken, expires_in: TOKEN_TTL_SECONDS };
  }

  function validCallback(raw: string): boolean {
    if (raw.includes('#')) return false;
    try {
      const url = new URL(raw);
      return url.origin === appOrigin && url.pathname === CALLBACK_PATH && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  function renderChooser(ticket: string): string {
    const form = (account: string, label: string) =>
      `<form method="get" action="/auth/continue"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}">` +
      `<input type="hidden" name="account" value="${escapeHtml(account)}"><button type="submit">${escapeHtml(label)}</button></form>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Private test identity</title></head>` +
      `<body><main><h1>Private test identity</h1>${[...accounts].map(([account, entry]) => form(account, entry.buttonName)).join('')}</main></body></html>`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.headers.origin === appOrigin) {
      res.setHeader('access-control-allow-origin', appOrigin);
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('vary', 'Origin');
    }
    const url = new URL(req.url ?? '/', origin);
    const route = `${req.method ?? ''} ${url.pathname}`;
    if (req.method === 'OPTIONS') return send(res, 204);

    if (route === 'GET /.well-known/jwks.json') {
      counters.jwksReads += 1;
      return send(res, 200, { keys: [jwk] });
    }
    if (route === 'GET /auth/login') {
      const callback = single(url.searchParams, 'redirect_uri');
      const state = single(url.searchParams, 'state');
      const modes = url.searchParams.getAll('mode');
      const modeOk = modes.length === 0 || (modes.length === 1 && modes[0] === 'redirect');
      if (!callback || !validCallback(callback) || !state || state.length > MAX_STATE_LENGTH || !modeOk) {
        return send(res, 400, 'Invalid login request', 'text/plain');
      }
      const ticket = opaque();
      tickets.set(ticket, { callback, state, expiresAt: Date.now() + TICKET_TTL_MS });
      counters.logins += 1;
      res.setHeader('content-security-policy', `default-src 'none'; frame-ancestors 'none'; form-action 'self' ${appOrigin}`);
      return send(res, 200, renderChooser(ticket), 'text/html');
    }
    if (route === 'GET /auth/continue') {
      const ticketId = single(url.searchParams, 'ticket');
      const account = single(url.searchParams, 'account');
      const ticket = ticketId ? tickets.get(ticketId) : undefined;
      const chosen = account === null ? undefined : accounts.get(account);
      if (!ticketId || !ticket || !chosen) {
        return send(res, 400, 'Invalid or used login ticket', 'text/plain');
      }
      tickets.delete(ticketId);
      if (ticket.expiresAt < Date.now()) return send(res, 400, 'Invalid or used login ticket', 'text/plain');
      const tokens = issueTokens(chosen.identity);
      const fragment = new URLSearchParams({ ...tokens, expires_in: String(tokens.expires_in), state: ticket.state });
      counters.completedLogins += 1;
      res.writeHead(302, { location: `${ticket.callback}#${fragment.toString()}` }).end();
      return;
    }
    if (route === 'POST /auth/refresh' || route === 'POST /auth/logout') {
      const token = await readRefreshToken(req);
      if (!token) return send(res, 400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request body' } });
      const identity = refreshTokens.get(token);
      refreshTokens.delete(token);
      if (route === 'POST /auth/logout') {
        counters.logouts += 1;
        return send(res, 200, { success: true, data: { revoked: true } });
      }
      if (!identity) {
        counters.refreshRejects += 1;
        return send(res, 401, { success: false, error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid refresh token' } });
      }
      counters.refreshes += 1;
      return send(res, 200, { success: true, data: issueTokens(identity) });
    }
    if (route === 'GET /auth/me') {
      const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.headers.authorization ?? '');
      const identity = match?.[1] ? verifyAccessToken(match[1]) : null;
      if (!identity) return send(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid access token' } });
      counters.meReads += 1;
      return send(res, 200, {
        success: true,
        data: {
          id: identity.id,
          email: identity.email,
          name: identity.name,
          email_verified: true,
          email_verification_assertion: 'google_gmail',
          email_verification_observed_at: observedAt,
        },
      });
    }
    return send(res, 404);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else send(res, 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  return {
    origin,
    identities,
    registerIdentity: (label) => {
      const clean = label.trim();
      if (!clean || clean.length > 80 || [...clean].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid private test identity label.');
      const identity = { id: randomUUID(), email: QA_EMAIL, name: QA_NAME };
      const buttonName = `Continue as ${clean}`;
      if ([...accounts.values()].some(entry => entry.buttonName === buttonName)) throw new Error('Private test identity label is already registered.');
      identityById.set(identity.id, identity);
      accounts.set(opaque(), { identity, buttonName });
      return { ...identity, buttonName };
    },
    stats: () => ({ ...counters }),
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        tickets.clear();
        refreshTokens.clear();
        accounts.clear();
        identityById.clear();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })),
  };
}
