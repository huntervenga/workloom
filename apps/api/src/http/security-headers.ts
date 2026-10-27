import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** SHA-256 source expressions of every inline <script> (one without src) found in the built HTML documents. */
export function inlineScriptHashes(distDir: string): string[] {
  const hashes = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(distDir).filter(name => name.endsWith('.html')); } catch { return []; }
  for (const name of names) {
    const html = readFileSync(join(distDir, name), 'utf8');
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      // HTML parsing normalizes CRLF and lone CR before the browser checks inline-script hashes.
      const body = (match[1] ?? '').replace(/\r\n?/g, '\n');
      if (body.trim() !== '') hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes].sort();
}

/**
 * The policy for the app, landing and docs pages: scripts only from this origin plus the exact inline scripts that ship
 * with the build; no framing; connections only back to this origin. Styles allow inline because the UI sets style attributes.
 */
export function documentPolicy(scriptHashes: readonly string[], allowLocalMedia = false): string {
  // Local S3 emulators may use HTTP; hosted configuration only accepts HTTPS storage.
  const localMedia = allowLocalMedia ? ' http://127.0.0.1:* http://localhost:*' : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: https:${localMedia}`,
    `media-src 'self' https:${localMedia}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Machine responses never render anything. */
export const API_POLICY = "default-src 'none'; frame-ancestors 'none'";
const HSTS = 'max-age=31536000; includeSubDomains';
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=()';

/** Adds the response-side security headers to every reply; HSTS only for hosted (https) deployments. */
export function registerSecurityHeaders(app: FastifyInstance, options: { webDistDir: string | null; hosted: boolean }): void {
  const documents = documentPolicy(options.webDistDir === null ? [] : inlineScriptHashes(options.webDistDir), !options.hosted);
  app.addHook('onSend', async (request, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) reply.header('content-security-policy', documents);
    else if (request.url.startsWith('/api') || request.url.startsWith('/mcp') || request.url.startsWith('/healthz')) reply.header('content-security-policy', API_POLICY);
    reply.header('permissions-policy', PERMISSIONS);
    if (options.hosted) reply.header('strict-transport-security', HSTS);
    return payload;
  });
}
