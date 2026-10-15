import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** apps/web/dist resolved from this module (apps/api/{src,dist}/http → apps/web/dist). */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

const IMMUTABLE_ASSET = 'public, max-age=31536000, immutable';

/** Returns the dist directory when it contains a built index.html, otherwise null. */
export function resolveWebDist(dir: string): string | null {
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

function isReservedPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/healthz' || path.startsWith('/healthz/');
}

/**
 * SPA fallback applies only to GET/HEAD navigations: outside /api and /healthz,
 * no file extension in the last segment, and an HTML-accepting client.
 */
export function shouldServeSpa(request: Pick<FastifyRequest, 'method' | 'url' | 'headers'>): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = request.url.split('?')[0] ?? '';
  if (isReservedPath(path)) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return false;
  const accept = request.headers.accept ?? '';
  return accept.includes('text/html') || accept.includes('*/*');
}

export function sendSpaIndex(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
}

/** Registers hashed assets and the root index. Missing files fall through to the not-found handler. */
export async function registerStaticWeb(app: FastifyInstance, distDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    wildcard: true,
    index: false,
    cacheControl: false,
    dotfiles: 'deny',
    setHeaders(reply, filePath) {
      reply.header('cache-control', filePath.includes(`${sep}assets${sep}`) ? IMMUTABLE_ASSET : 'no-cache');
    },
  });
  app.get('/', async (_request, reply) => sendSpaIndex(reply));
}
