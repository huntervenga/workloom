import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** apps/web/dist resolved from this module (apps/api/{src,dist}/http → apps/web/dist). */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** Public landing document served at '/'. */
export const LANDING_DOCUMENT = 'landing.html';
/** SPA document served only for navigations under APP_PREFIX. */
export const SPA_DOCUMENT = 'index.html';
export const APP_PREFIX = '/app';
/** Pre-landing SPA workspace routes; HTML navigations move under APP_PREFIX. */
const LEGACY_APP_PREFIX = '/w';

/** Auth callback route; tokens arrive in its fragment, so its document is never stored. */
export const AUTH_CALLBACK_PATH = `${APP_PREFIX}/auth/callback`;

const IMMUTABLE_ASSET = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
const NO_STORE = 'no-store';
const CANONICAL_REDIRECT = 308;

type DocumentCachePolicy = typeof REVALIDATE | typeof NO_STORE;

type NavigationRequest = Pick<FastifyRequest, 'method' | 'url' | 'headers'>;

/** Returns the dist directory when it contains both built documents, otherwise null. */
export function resolveWebDist(dir: string): string | null {
  return existsSync(join(dir, SPA_DOCUMENT)) && existsSync(join(dir, LANDING_DOCUMENT)) ? dir : null;
}

/** Splits the raw request target into its path and raw query ('' or '?…'); a fragment is never kept. */
function splitTarget(url: string): { readonly path: string; readonly query: string } {
  const target = url.split('#', 1)[0] ?? '';
  const queryStart = target.indexOf('?');
  return queryStart === -1 ? { path: target, query: '' } : { path: target.slice(0, queryStart), query: target.slice(queryStart) };
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** GET/HEAD from an HTML-accepting client with no file extension in the last segment. */
function isHtmlNavigation(request: NavigationRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const { path } = splitTarget(request.url);
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return false;
  const accept = request.headers.accept ?? '';
  return accept.includes('text/html') || accept.includes('*/*');
}

/** SPA fallback applies only to HTML navigations at /app or below; everything else stays a JSON 404. */
export function shouldServeSpa(request: NavigationRequest): boolean {
  return isHtmlNavigation(request) && isUnder(splitTarget(request.url).path, APP_PREFIX);
}

/**
 * Origin-relative /app location for a legacy /w HTML navigation, or null. The raw query is kept
 * byte-for-byte; no fragment is emitted, so the browser carries its own fragment over.
 */
export function legacyAppLocation(request: NavigationRequest): string | null {
  if (!isHtmlNavigation(request)) return null;
  const { path, query } = splitTarget(request.url);
  return isUnder(path, LEGACY_APP_PREFIX) ? `${APP_PREFIX}${path}${query}` : null;
}

export function sendSpaIndex(reply: FastifyReply, cacheControl: DocumentCachePolicy = REVALIDATE): FastifyReply {
  return reply
    .header('x-robots-tag', 'noindex')
    .header('cache-control', cacheControl)
    .type('text/html; charset=utf-8')
    .sendFile(SPA_DOCUMENT);
}

export function sendLanding(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile(LANDING_DOCUMENT);
}

/** Not-found fallback for web navigations: legacy redirect or the /app SPA; null leaves the JSON 404. */
export function replyWebNavigation(request: NavigationRequest, reply: FastifyReply): FastifyReply | null {
  const legacy = legacyAppLocation(request);
  if (legacy !== null) return reply.redirect(legacy, CANONICAL_REDIRECT);
  if (!shouldServeSpa(request)) return null;
  return sendSpaIndex(reply, splitTarget(request.url).path === AUTH_CALLBACK_PATH ? NO_STORE : REVALIDATE);
}

/**
 * The two HTML documents are served only through their canonical routes: the landing at '/', the
 * SPA under /app. Direct or encoded file requests for either fall through to the not-found handler.
 */
function isAllowedStaticPath(pathName: string, _root: string, request: FastifyRequest): boolean {
  const name = pathName.replace(/^\/+|\/+$/g, '').toLowerCase();
  const { path } = splitTarget(request.url);
  if (name === SPA_DOCUMENT) return isUnder(path, APP_PREFIX);
  if (name === LANDING_DOCUMENT) return path === '/';
  return true;
}

/** Registers assets and SEO files, the root landing and canonical document aliases. Missing files fall through to the not-found handler. */
export async function registerStaticWeb(app: FastifyInstance, distDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    wildcard: true,
    index: false,
    cacheControl: false,
    dotfiles: 'deny',
    allowedPath: isAllowedStaticPath,
    // Runs inside sendFile after the route set its headers: assets are immutable, other files
    // revalidate, but a route's explicit no-store (the auth callback document) must survive.
    setHeaders(reply, filePath) {
      if (filePath.includes(`${sep}assets${sep}`)) reply.header('cache-control', IMMUTABLE_ASSET);
      else if (reply.getHeader('cache-control') !== NO_STORE) reply.header('cache-control', REVALIDATE);
    },
  });
  app.get('/', async (_request, reply) => sendLanding(reply));
  app.get(`/${SPA_DOCUMENT}`, async (request, reply) => reply.redirect(`${APP_PREFIX}${splitTarget(request.url).query}`, CANONICAL_REDIRECT));
  app.get(`/${LANDING_DOCUMENT}`, async (request, reply) => reply.redirect(`/${splitTarget(request.url).query}`, CANONICAL_REDIRECT));
}
