import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { documentPolicy, inlineScriptHashes, registerSecurityHeaders } from './security-headers.js';

describe('security headers', () => {
  it('hashes only inline scripts, exactly as written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-'));
    try {
      const inline = '\n  window.x = 1;\n';
      writeFileSync(join(dir, 'a.html'), `<script src="/a.js"></script><script>${inline}</script><script type="module" src="/b.js"></script><script> </script>`);
      expect(inlineScriptHashes(dir)).toEqual([`'sha256-${createHash('sha256').update(inline).digest('base64')}'`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('forbids framing, foreign scripts and plugins, and keeps connections on the same origin', () => {
    const policy = documentPolicy(["'sha256-abc'"]);
    expect(policy).toContain("script-src 'self' 'sha256-abc'");
    for (const part of ["frame-ancestors 'none'", "object-src 'none'", "connect-src 'self'", "base-uri 'self'"]) expect(policy).toContain(part);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
  it('sends the document policy on HTML, a locked policy on API replies and HSTS only when hosted', async () => {
    for (const hosted of [false, true]) {
      const app = Fastify();
      registerSecurityHeaders(app, { webDistDir: null, hosted });
      app.get('/page', async (_request, reply) => reply.type('text/html').send('<p>hi</p>'));
      app.get('/api/thing', async () => ({ ok: true }));
      const page = await app.inject('/page'), api = await app.inject('/api/thing');
      expect(page.headers['content-security-policy']).toContain("default-src 'self'");
      expect(api.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(page.headers['permissions-policy']).toContain('camera=()');
      expect(page.headers['strict-transport-security'] !== undefined).toBe(hosted);
      await app.close();
    }
  });
});
