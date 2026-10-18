import { describe, expect, it } from 'vitest';

import { allowedHosts, assertAllowedHost, assertTrustedOrigin, trustedOrigins } from './request-guards.js';

const options = { hosted: true, getPort: () => 8080, appOrigins: ['https://workloom.example.com'] };
describe('hosted request boundaries', () => {
  it('trusts only the canonical Host and browser Origin', () => {
    expect([...allowedHosts(options)]).toEqual(['workloom.example.com']);
    expect([...trustedOrigins(options)]).toEqual(['https://workloom.example.com']);
    expect(() => assertAllowedHost({ method: 'GET', headers: { host: 'workloom.example.com' } }, options)).not.toThrow();
    expect(() => assertTrustedOrigin({ method: 'POST', headers: { origin: 'https://workloom.example.com' } }, options)).not.toThrow();
  });
  it.each(['localhost:8080', '127.0.0.1:8080', 'workloom.example.com.evil.com', 'workloom.example.com:8080'])('rejects Host %s', (host) => {
    expect(() => assertAllowedHost({ method: 'GET', headers: { host } }, options)).toThrow();
  });
  it.each([undefined, 'http://localhost:8080', 'https://evil.example.com'])('rejects write Origin %s', (origin) => {
    expect(() => assertTrustedOrigin({ method: 'POST', headers: { origin } }, options)).toThrow();
  });
  it('does not let a trusted origin override cross-site metadata', () => {
    expect(() => assertTrustedOrigin({ method: 'PATCH', headers: { origin: options.appOrigins[0], 'sec-fetch-site': 'cross-site' } }, options)).toThrow();
  });
  it.each(['GET', 'HEAD'])('allows only Railway %s readiness requests', (method) => {
    expect(() => assertAllowedHost({ method, url: '/healthz/ready', headers: { host: 'healthcheck.railway.app' } }, options)).not.toThrow();
  });
  it.each([
    ['GET', '/api/v1/me'], ['GET', '/healthz/ready?x=1'], ['GET', '/healthz/ready/'],
    ['POST', '/healthz/ready'], ['OPTIONS', '/healthz/ready'],
  ])('does not extend the health Host exception to %s %s', (method, url) => {
    expect(() => assertAllowedHost({ method, url, headers: { host: 'healthcheck.railway.app' } }, options)).toThrow();
  });
  it('keeps the existing local implicit origins without a Railway exception', () => {
    const local = { getPort: () => 4310, appOrigins: [] };
    expect(trustedOrigins(local).has('http://127.0.0.1:4310')).toBe(true);
    expect(() => assertAllowedHost({ method: 'GET', url: '/healthz/ready', headers: { host: 'healthcheck.railway.app' } }, local)).toThrow();
  });
});
