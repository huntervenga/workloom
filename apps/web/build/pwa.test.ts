import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const publicFile = (path: string) => readFileSync(fileURLToPath(new NodeURL(`../public/${path}`, import.meta.url)));
const source = publicFile('app/sw.js').toString();
function worker() {
  const events = new Map<string, (event: unknown) => void>();
  const put = vi.fn(), match = vi.fn(), remove = vi.fn();
  const fetch = vi.fn(async () => new Response('online', { headers: { 'content-type': 'text/html' } }));
  const open = vi.fn(async () => ({ put }));
  runInNewContext(source, { self: { location: { origin: 'https://workloom.test' }, addEventListener: (name: string, handler: (event: unknown) => void) => events.set(name, handler) }, caches: { open, match, keys: async () => ['workloom-offline-old', 'unrelated-cache'], delete: remove }, fetch, Response, URL });
  const navigate = (path: string, options: { mode?: string; method?: string } = {}) => {
    let response: Promise<Response> | undefined;
    events.get('fetch')!({ request: { url: new URL(path, 'https://workloom.test').href, method: options.method ?? 'GET', mode: options.mode ?? 'navigate' }, respondWith: (next: Promise<Response>) => { response = next; } });
    return response;
  };
  return { events, fetch, open, put, match, remove, navigate };
}
describe('PWA resources', () => {
  it('ships stable app identity, standalone scope and real PNG icons at declared sizes', () => {
    const manifest = JSON.parse(publicFile('manifest.webmanifest').toString());
    expect(manifest).toMatchObject({ id: '/app', start_url: '/app/', scope: '/app/', display: 'standalone' });
    for (const icon of manifest.icons) {
      const png = publicFile(icon.src.slice(1));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
    const apple = publicFile('icons/apple-touch-icon.png'); expect(apple.readUInt32BE(16)).toBe(180);
    const html = readFileSync(fileURLToPath(new NodeURL('../index.html', import.meta.url)), 'utf8');
    expect(html).toContain('href="/manifest.webmanifest"'); expect(html).toContain('viewport-fit=cover');
  });
  it('caches only the public reconnect document on install and cleans only its own old caches', async () => {
    const h = worker(); let work: Promise<unknown> | undefined;
    const event = { waitUntil: (promise: Promise<unknown>) => { work = promise; } };
    h.events.get('install')!(event); await work;
    expect(h.fetch).toHaveBeenCalledWith('/app/offline.html', { cache: 'reload', credentials: 'omit' });
    expect(h.put).toHaveBeenCalledTimes(1); expect(h.put.mock.calls[0]?.[0]).toBe('/app/offline.html');
    h.events.get('activate')!(event); await work;
    expect(h.remove).toHaveBeenCalledExactlyOnceWith('workloom-offline-old');
  });
  it('passes online navigations through and shows only a public fallback when offline', async () => {
    const h = worker(); expect(await (await h.navigate('/app/w/team/projects'))!.text()).toBe('online');
    h.fetch.mockRejectedValue(new TypeError('offline'));
    h.match.mockResolvedValue(new Response('reconnect'));
    expect(await (await h.navigate('/app/w/team/projects'))!.text()).toBe('reconnect');
    expect(h.put).not.toHaveBeenCalled();
  });
  it('never intercepts API writes, auth callbacks, assets, landing or other origins', () => {
    const h = worker();
    for (const path of ['/api/v1/me', '/app/auth/callback', '/app/auth/callback/?secret=x', '/', 'https://other.test/app/']) expect(h.navigate(path)).toBeUndefined();
    expect(h.navigate('/assets/app.js', { mode: 'cors' })).toBeUndefined();
    expect(h.navigate('/app/w/team', { method: 'POST' })).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
