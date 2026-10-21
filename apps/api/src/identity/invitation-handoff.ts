import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { acceptTeamInvitationInputSchema, type AcceptTeamInvitationInput } from '@workloom/contracts';
import { z } from 'zod';
import type { SharedAuthConfig } from '../config.js';

export const INVITATION_HANDOFF_COOKIE = 'workloom_invitation_handoff';
const TTL_SECONDS = 600;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const payloadSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['staged', 'login', 'ready']),
  credential: acceptTeamInvitationInputSchema,
  expiresAt: z.number().int().positive(),
  binding: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
type Payload = z.infer<typeof payloadSchema>;

/** Only a short-lived encrypted HttpOnly cookie carries the capability through the local BFF.
 * It is never copied into OAuth state, returnTo, provider URLs or browser storage.
 */
export interface InvitationHandoff {
  stage(credential: AcceptTeamInvitationInput): string;
  bindLogin(encoded: string | undefined, attemptToken: string, returnTo: string, previousSession?: string): string;
  complete(encoded: string | undefined, attemptToken: string | undefined, sessionToken: string): { readonly cookie: string; readonly ready: boolean };
  resume(encoded: string | undefined, sessionToken: string | undefined): AcceptTeamInvitationInput | null;
  clearCookie(): string;
}
export function createInvitationHandoff(config: SharedAuthConfig, now: () => Date = () => new Date()): InvitationHandoff {
  const key = config.sessionKey.bytes();
  const aad = Buffer.from(`workloom.invitation-handoff.v1:${config.appOrigin}`, 'utf8');
  const clearCookie = () => `${INVITATION_HANDOFF_COOKIE}=; Path=/api/v1/auth; Max-Age=0; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;
  function seal(payload: Payload): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
  }
  function read(encoded: string | undefined): Payload | null {
    if (!encoded || encoded.length > 2048) return null;
    try {
      const parts = encoded.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
      const [nonce, tag, body] = parts.map(part => Buffer.from(part, 'base64url'));
      if (!nonce || nonce.length !== 12 || !tag || tag.length !== 16 || !body) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad); decipher.setAuthTag(tag);
      const parsed = payloadSchema.safeParse(JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')));
      if (!parsed.success || parsed.data.expiresAt <= now().getTime() || parsed.data.expiresAt > now().getTime() + TTL_SECONDS * 1000) return null;
      if ((parsed.data.kind === 'staged') !== (parsed.data.binding === undefined)) return null;
      return parsed.data;
    } catch { return null; }
  }
  function cookie(payload: Payload): string {
    const maxAge = Math.max(0, Math.ceil((payload.expiresAt - now().getTime()) / 1000));
    return `${INVITATION_HANDOFF_COOKIE}=${seal(payload)}; Path=/api/v1/auth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;
  }
  function matches(binding: string | undefined, token: string | undefined): boolean {
    return binding !== undefined && token !== undefined && opaque.test(token) && timingSafeEqual(Buffer.from(binding, 'hex'), Buffer.from(hash(token), 'hex'));
  }
  return {
    stage(input) {
      const credential = acceptTeamInvitationInputSchema.parse(input);
      const bytes = Buffer.from(credential.secret, 'base64url');
      if (bytes.length !== 32 || bytes.toString('base64url') !== credential.secret) throw new Error('Invalid invitation material.');
      return cookie({ v: 1, kind: 'staged', credential, expiresAt: now().getTime() + TTL_SECONDS * 1000 });
    },
    bindLogin(encoded, attemptToken, returnTo, previousSession) {
      const payload = read(encoded);
      if (returnTo !== '/app/join' || !opaque.test(attemptToken) || !payload ||
          (payload.kind !== 'staged' && !(payload.kind === 'ready' && matches(payload.binding, previousSession)))) return clearCookie();
      return cookie({ ...payload, kind: 'login', binding: hash(attemptToken) });
    },
    complete(encoded, attemptToken, sessionToken) {
      const payload = read(encoded);
      if (!payload || payload.kind !== 'login' || !matches(payload.binding, attemptToken) || !opaque.test(sessionToken)) return { cookie: clearCookie(), ready: false };
      return { cookie: cookie({ ...payload, kind: 'ready', binding: hash(sessionToken) }), ready: true };
    },
    resume(encoded, sessionToken) {
      const payload = read(encoded);
      return payload?.kind === 'ready' && matches(payload.binding, sessionToken) ? payload.credential : null;
    },
    clearCookie,
  };
}
