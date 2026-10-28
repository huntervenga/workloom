import { z } from 'zod';

/** Browser and Node both provide WHATWG URL; contracts intentionally has no DOM library. */
interface ProfilePhotoUrlParts {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly port: string;
  readonly hash: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly search: string;
  readonly href: string;
}
// Type-only ambient declaration: emits no constructor or runtime replacement.
declare const URL: new (input: string) => ProfilePhotoUrlParts;

export const MAX_PROFILE_PHOTO_URL_LENGTH = 2048;
const MAX_SIZE_HINT = 2048;

/** Raw input must already be an absolute https URL; no controls, whitespace, backslashes or fragments. */
const RAW_PREFIX = /^https:\/\//i;
const RAW_FORBIDDEN = /[\p{Cc}\s\\#]/u;
/** Normalized DNS name: lowercase LDH labels, at least two labels, alphabetic or IDN top-level label. */
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Conservative path alphabet; covers provider paths like `/a/AbC-12_x=s96-c` without percent escapes. */
const PATH = /^\/[A-Za-z0-9._~\-=+,/]*$/;
/** The only accepted query is a single provider size hint. */
const SIZE_QUERY = /^sz=([1-9][0-9]{0,3})$/;
const RESERVED_TOP_LEVEL = new Set([
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'invalid',
  'test',
  'example',
  'onion',
  'arpa',
  'lan',
  'home',
  'corp',
  'private',
]);

function isPublicDnsHost(hostname: string): boolean {
  const labels = hostname.split('.');
  if (labels.length < 2 || hostname.length > 253) return false;
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  const top = labels.at(-1) ?? '';
  // Numeric top-level labels cover every IPv4 literal form after WHATWG normalization; IPv6 fails HOST_LABEL.
  return TOP_LEVEL_LABEL.test(top) && !RESERVED_TOP_LEVEL.has(top);
}

/**
 * Normalized href of a displayable profile photo URL, or null. Accepts only
 * bounded absolute https URLs on public DNS hosts with no credentials, port,
 * fragment, IP literal or query other than one `sz=1..2048` size hint. The
 * URL is never fetched or proxied by Workloom.
 */
export function safeProfilePhotoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROFILE_PHOTO_URL_LENGTH) return null;
  if (!RAW_PREFIX.test(value) || RAW_FORBIDDEN.test(value)) return null;
  let url: ProfilePhotoUrlParts;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return null;
  if (!isPublicDnsHost(url.hostname) || !PATH.test(url.pathname)) return null;
  if (url.search !== '') {
    const size = SIZE_QUERY.exec(url.search.slice(1));
    if (size === null || Number(size[1]) > MAX_SIZE_HINT) return null;
  } else if (url.href.includes('?')) {
    return null;
  }
  return url.href.length <= MAX_PROFILE_PHOTO_URL_LENGTH ? url.href : null;
}

const UPLOADED_AVATAR = /^\/api\/v1\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Only this exact authenticated same-origin path may complement a verified provider URL. */
export function safeUserAvatarUrl(value: unknown): string | null {
  return typeof value === 'string' && UPLOADED_AVATAR.test(value) ? value : safeProfilePhotoUrl(value);
}
export function uploadedAvatarUrl(userId: string, avatarId: string): string {
  return `/api/v1/users/${userId}/avatars/${avatarId}`;
}

/** Strict DTO field: verified provider URL or the exact authenticated uploaded-avatar path. Compose with `.nullable().optional()`. */
export const profilePhotoUrlSchema = z
  .string()
  .max(MAX_PROFILE_PHOTO_URL_LENGTH)
  .refine((value) => safeUserAvatarUrl(value) === value, { message: 'Invalid profile photo URL.' });

export type ProfilePhotoUrl = z.infer<typeof profilePhotoUrlSchema>;
